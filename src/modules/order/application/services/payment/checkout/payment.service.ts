// Điều phối checkout Pay2S, IPN/redirect và hậu xử lý order; provider adapter giữ riêng HTTP/chữ ký.
import {
    BadRequestException,
    Injectable,
    Inject,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import { Pay2sGatewayService } from '@/modules/order/application/services/payment/checkout/pay2s-gateway.service';
import { CartClient } from '@/modules/order/application/clients/cart.client';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { ProductClient } from '@/modules/order/application/clients/product.client';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type {
    Pay2sEnvironment,
    Pay2sInvoiceMetadata,
    Pay2sIpnPayload,
    Pay2sRedirectPayload,
} from '@/modules/order/application/types/payments/pay2s.types';

type PaymentReturnResponse =
    | { status: 'PAID'; orderId: string }
    | { status: 'WALLET_DEPOSIT_PAID'; depositId: string }
    | {
          status:
              | 'FAILED'
              | 'REFUND_PENDING'
              | 'REFUNDED'
              | 'PENDING'
              | 'WALLET_DEPOSIT_FAILED'
              | 'UNVERIFIED';
      };

// IPN/redirect có hai canonical string khác nhau; không dùng redirect để tự động ghi nhận tiền.
@Injectable()
export class PaymentService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PaymentService.name);
    private expirationTimer?: NodeJS.Timeout;
    private expirationRunning = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly config: ConfigService,
        private readonly gateway: Pay2sGatewayService,
        private readonly cartClient: CartClient,
        private readonly orderEvents: OrderEventsService,
        private readonly productClient: ProductClient,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly sellerWalletRepository: SellerWalletRepositoryPort,
    ) {}

    // Chỉ dùng để đánh dấu order sandbox; callback sandbox vẫn phải qua đủ chữ ký, amount và idempotency.
    isSandboxMode(): boolean {
        return this.config.get<string>('PAY2S_MODE', 'disabled') === 'sandbox';
    }

    // Chặn checkout trước khi reserve tồn kho để không tạo order pending khi Pay2S chưa được cấu hình.
    assertPay2sCheckoutAllowed(): void {
        this.gateway.assertCheckoutEnabled();
    }

    // Quét order Pay2S quá hạn theo batch nhỏ để release reservation và đánh dấu attempt hết hạn.
    onModuleInit(): void {
        this.expirationTimer = setInterval(
            () =>
                void this.expirePendingOrders().catch((error: unknown) =>
                    this.logger.error(
                        'Không quét được order Pay2S hết hạn.',
                        error instanceof Error ? error.stack : undefined,
                    ),
                ),
            30_000,
        );
        void this.expirePendingOrders().catch((error: unknown) =>
            this.logger.error(
                'Không quét được order Pay2S hết hạn lúc khởi động.',
                error instanceof Error ? error.stack : undefined,
            ),
        );
    }

    // Dừng timer khi service shutdown để không giữ process hoặc unit test mở.
    onModuleDestroy(): void {
        if (this.expirationTimer) clearInterval(this.expirationTimer);
    }

    // Tạo attempt trước khi gọi provider để timeout vẫn giữ nguyên merchant orderId cho lần retry kế tiếp.
    // requestId được thay mới ở mỗi lần gọi, còn amount/metadata lấy từ snapshot order bất biến.
    async startPay2sPayment(
        order: Order,
        _ipAddress: string,
    ): Promise<{ paymentUrl: string; attempt: PaymentAttempt }> {
        if (
            order.paymentMethod !== PaymentMethod.PAY2S ||
            order.paymentStatus !== PaymentStatus.PENDING
        )
            throw new BadRequestException(
                'Đơn hàng không ở trạng thái chờ thanh toán Pay2S.',
            );

        const repository = this.dataSource.getRepository(PaymentAttempt);
        let attempt = await repository.findOne({
            where: { orderId: order.id, status: 'PENDING' },
        });
        if (!attempt) {
            attempt = repository.create({
                orderId: order.id,
                merchantReference: this.gateway.createMerchantReference(),
                providerRequestId: null,
                providerOrderInfo: null,
                providerTransactionId: null,
                status: 'PENDING',
                environment: this.getEnvironment(),
                amount: order.totalAmount,
                currency: 'VND',
                expiresAt:
                    order.paymentExpiresAt ??
                    new Date(Date.now() + 15 * 60_000),
                providerCreateDate: null,
                confirmedAt: null,
                refundRequestId: null,
                providerResponse: null,
            });
            try {
                attempt = await repository.save(attempt);
            } catch (error) {
                // Unique index chỉ cho phép một attempt pending/order; request thua race đọc lại attempt thắng.
                if ((error as { code?: string }).code !== '23505') throw error;
                const concurrentAttempt = await repository.findOne({
                    where: { orderId: order.id, status: 'PENDING' },
                });
                if (!concurrentAttempt) throw error;
                attempt = concurrentAttempt;
            }
        }
        if (attempt.expiresAt <= new Date())
            throw new BadRequestException('Phiên thanh toán đã hết hạn.');

        const paymentUrl = await this.createPay2sLink(order, attempt);
        return { paymentUrl, attempt };
    }

    // Ghi nhận remittance COD sau khi admin đối soát; luồng này không phụ thuộc provider online.
    async confirmCodRemittance(
        orderId: string,
        adminId: string,
        reference: string,
    ): Promise<void> {
        if (!adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.sellerWalletRepository.confirmCodRemittance(
            orderId,
            adminId,
            reference,
        );
    }

    // Admin xác nhận COD hoàn ngoài hệ thống; proof/reference được lưu để audit và retry idempotent.
    async recordCodRefund(input: {
        returnRequestId: string;
        adminId: string;
        reference: string;
        amount: string;
        proof: Record<string, unknown>;
    }): Promise<void> {
        if (!input.adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.sellerWalletRepository.recordCodRefund(input);
    }

    // Hoàn Pay2S cũng do admin chuyển khoản thủ công; không tạo request hoàn tự động ở provider.
    async recordPay2sRefund(input: {
        returnRequestId: string;
        adminId: string;
        reference: string;
        amount: string;
        proof: Record<string, unknown>;
    }): Promise<void> {
        if (!input.adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.sellerWalletRepository.recordPay2sRefund(input);
    }

    // Ghi nhận refund cho IPN đến sau khi order đã hủy; case này không đi qua return request và không reverse seller wallet.
    async recordPay2sLateRefund(input: {
        orderId: string;
        adminId: string;
        reference: string;
        amount: string;
        proof: Record<string, unknown>;
    }): Promise<void> {
        if (!input.adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.sellerWalletRepository.recordPay2sLateRefund(input);
    }

    // Tạo top-up Pay2S độc lập với PaymentAttempt của order; IPN hợp lệ mới ghi có ví seller.
    async createWalletDeposit(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        ipAddress: string;
    }) {
        const amount = Number(input.amount);
        if (
            !Number.isSafeInteger(amount) ||
            amount < 10_000 ||
            amount > 1_000_000_000
        )
            throw new BadRequestException(
                'Số tiền nạp phải từ 10.000 đến 1.000.000.000 đồng.',
            );

        const merchantReference = this.gateway.createMerchantReference('W');
        const expiresAt = new Date(Date.now() + 15 * 60_000);
        const requestId = this.gateway.createMerchantReference('REQ');
        const deposit = await this.sellerWalletRepository.createWalletDeposit({
            shopId: input.shopId,
            sellerUserId: input.sellerUserId,
            amount: input.amount,
            merchantReference,
            expiresAt,
            environment: this.getEnvironment(),
            providerRequestId: requestId,
        });
        const result = await this.gateway.createPayment({
            orderId: merchantReference,
            requestId,
            amount: input.amount,
            orderInfo: `Nap tien vi ${input.shopId}`,
            redirectUrl: this.config.get<string>('PAY2S_WALLET_RETURN_URL', ''),
            ipnUrl: this.config.get<string>('PAY2S_WALLET_IPN_URL', ''),
            metadata: this.createWalletMetadata(input.amount),
            environment: this.getEnvironment(),
        });
        await this.sellerWalletRepository.updateWalletDepositProvider({
            depositId: deposit.id,
            providerOrderInfo: result.orderInfo,
            providerResponse: result.response,
        });
        return { deposit, paymentUrl: result.payUrl };
    }

    // IPN là nguồn ghi nhận bền vững: verify chữ ký, đối chiếu tiền rồi khóa attempt/order trong transaction.
    // Callback trùng chỉ ACK thành công; side effect chỉ chạy ở lần chuyển trạng thái PENDING -> PAID.
    async processPay2sIpn(
        body: Record<string, unknown>,
    ): Promise<{ success: boolean }> {
        const payload = this.toIpnPayload(body);
        if (!payload || !this.gateway.verifyIpn(payload)) {
            this.logger.warn(
                'Pay2S IPN bị từ chối do payload/chữ ký không hợp lệ.',
            );
            return { success: false };
        }
        const attempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({ where: { merchantReference: payload.orderId } });
        if (!attempt)
            return this.processWalletDepositIpn(payload.orderId, payload);

        if (!this.isAmountEqual(payload.amount, attempt.amount)) {
            this.logger.warn(
                `Pay2S IPN không khớp amount. attemptId=${attempt.id}`,
            );
            return { success: false };
        }
        if (String(payload.resultCode) !== '0') {
            await this.markAttemptFailed(attempt.id, payload);
            return { success: true };
        }
        if (!payload.transId.trim()) return { success: false };

        const outcome = await this.dataSource.transaction(async (manager) => {
            const attemptRepository = manager.getRepository(PaymentAttempt);
            const lockedAttempt = await attemptRepository.findOne({
                where: { id: attempt.id },
                lock: { mode: 'pessimistic_write' },
            });
            if (!lockedAttempt)
                throw new NotFoundException('Không tìm thấy giao dịch Pay2S.');
            if (lockedAttempt.status === 'PAID')
                return lockedAttempt.providerTransactionId === payload.transId
                    ? 'duplicate'
                    : 'not-pending';
            if (
                lockedAttempt.status === 'REFUND_PENDING' ||
                lockedAttempt.status === 'REFUNDED'
            ) {
                lockedAttempt.providerTransactionId = payload.transId;
                lockedAttempt.providerOrderInfo = payload.orderInfo;
                lockedAttempt.providerResponse = this.redactCallback(payload);
                await attemptRepository.save(lockedAttempt);
                return 'late-payment';
            }

            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository.findOne({
                where: { id: lockedAttempt.orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!order)
                throw new NotFoundException('Không tìm thấy đơn hàng Pay2S.');
            const anotherAttemptPaid = await attemptRepository
                .createQueryBuilder('attempt')
                .where('attempt.order_id = :orderId', { orderId: order.id })
                .andWhere('attempt.status = :status', { status: 'PAID' })
                .andWhere('attempt.id <> :attemptId', {
                    attemptId: lockedAttempt.id,
                })
                .getExists();

            lockedAttempt.providerTransactionId = payload.transId;
            lockedAttempt.providerOrderInfo = payload.orderInfo;
            lockedAttempt.providerResponse = this.redactCallback(payload);
            lockedAttempt.confirmedAt = new Date();
            if (
                anotherAttemptPaid ||
                lockedAttempt.status !== 'PENDING' ||
                lockedAttempt.expiresAt <= new Date() ||
                order.status !== OrderStatus.PENDING
            ) {
                // Tiền đến sau khi order đã đóng không được hồi sinh đơn; attempt chuyển hàng chờ admin hoàn.
                lockedAttempt.status = 'REFUND_PENDING';
                if (
                    !anotherAttemptPaid &&
                    order.paymentStatus !== PaymentStatus.PAID
                ) {
                    const previousStatus = order.status;
                    order.paymentStatus = PaymentStatus.REFUND_PENDING;
                    order.status = OrderStatus.CANCELLED;
                    order.fulfillmentStatus =
                        'CANCELLED' as Order['fulfillmentStatus'];
                    await manager.getRepository(OrderStatusHistory).save({
                        orderId: order.id,
                        fromStatus: previousStatus,
                        toStatus: OrderStatus.CANCELLED,
                        reason: 'Hủy vì thanh toán Pay2S đến muộn; chờ hoàn thủ công.',
                    });
                }
                await attemptRepository.save(lockedAttempt);
                await orderRepository.save(order);
                return 'late-payment';
            }

            lockedAttempt.status = 'PAID';
            const previousStatus = order.status;
            order.paymentStatus = PaymentStatus.PAID;
            order.status = OrderStatus.CONFIRMED;
            await attemptRepository.save(lockedAttempt);
            await orderRepository.save(order);
            await manager.getRepository(OrderStatusHistory).save({
                orderId: order.id,
                fromStatus: previousStatus,
                toStatus: OrderStatus.CONFIRMED,
                reason: 'Pay2S xác nhận thanh toán qua IPN đã ký.',
            });
            await this.orderEvents.enqueueCreatedForOrder(order.id, manager);
            return 'paid';
        });

        if (outcome === 'paid') await this.runPaidSideEffects(attempt.orderId);
        if (outcome === 'late-payment') {
            const cancelledOrder = await this.dataSource
                .getRepository(Order)
                .findOne({
                    where: {
                        id: attempt.orderId,
                        status: OrderStatus.CANCELLED,
                    },
                    relations: { items: true },
                });
            if (cancelledOrder)
                await this.releaseOrderReservation(cancelledOrder);
            this.logger.warn(
                `Pay2S payment late cần admin hoàn thủ công. attemptId=${attempt.id}`,
            );
        }
        return { success: true };
    }

    // Redirect chỉ xác minh và đọc trạng thái đã lưu; không dùng trình duyệt làm nguồn authoritative cho payment.
    async processPay2sReturn(
        query: Record<string, unknown>,
    ): Promise<PaymentReturnResponse> {
        const payload = this.toRedirectPayload(query);
        if (!payload || !this.gateway.verifyRedirect(payload))
            return { status: 'UNVERIFIED' };
        const attempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({ where: { merchantReference: payload.orderId } });
        if (!attempt) {
            const deposit =
                await this.sellerWalletRepository.getWalletDepositByReference(
                    payload.orderId,
                );
            if (!deposit || !this.isAmountEqual(payload.amount, deposit.amount))
                return { status: 'UNVERIFIED' };
            if (
                deposit.status === 'PAID' &&
                deposit.providerTransactionId === String(payload.transId ?? '')
            )
                return { status: 'WALLET_DEPOSIT_PAID', depositId: deposit.id };
            if (deposit.status === 'FAILED')
                return { status: 'WALLET_DEPOSIT_FAILED' };
            return { status: 'PENDING' };
        }
        if (!this.isAmountEqual(payload.amount, attempt.amount))
            return { status: 'UNVERIFIED' };
        if (
            attempt.status === 'PAID' &&
            attempt.providerTransactionId === String(payload.transId ?? '')
        )
            return { status: 'PAID', orderId: attempt.orderId };
        if (attempt.status === 'REFUND_PENDING')
            return { status: 'REFUND_PENDING' };
        if (attempt.status === 'REFUNDED') return { status: 'REFUNDED' };
        if (attempt.status === 'FAILED') return { status: 'FAILED' };
        return { status: 'PENDING' };
    }

    // IPN wallet dùng cùng verify Pay2S nhưng ghi số dư qua repository trong một transaction idempotent.
    private async processWalletDepositIpn(
        merchantReference: string,
        payload: Pay2sIpnPayload,
    ): Promise<{ success: boolean }> {
        const deposit =
            await this.sellerWalletRepository.getWalletDepositByReference(
                merchantReference,
            );
        if (!deposit || !this.isAmountEqual(payload.amount, deposit.amount))
            return { success: false };
        if (String(payload.resultCode) !== '0') {
            await this.sellerWalletRepository.failWalletDeposit(
                deposit.id,
                this.redactCallback(payload),
            );
            return { success: true };
        }
        if (!payload.transId.trim()) return { success: false };
        await this.sellerWalletRepository.confirmWalletDeposit({
            depositId: deposit.id,
            transactionId: payload.transId,
            providerResponse: this.redactCallback(payload),
        });
        return { success: true };
    }

    // Worker hết hạn chỉ đóng order pending, nhả reservation và gọi cancel best-effort; không tự tạo refund.
    private async expirePendingOrders(): Promise<void> {
        if (this.expirationRunning) return;
        this.expirationRunning = true;
        try {
            await this.runExpirationPass();
        } finally {
            this.expirationRunning = false;
        }
    }

    // Mỗi lượt giới hạn 50 order để callback và worker không tranh lock quá lâu.
    private async runExpirationPass(): Promise<void> {
        const now = new Date();
        const candidates = await this.dataSource.getRepository(Order).find({
            where: {
                paymentMethod: PaymentMethod.PAY2S,
                status: OrderStatus.PENDING,
                paymentExpiresAt: LessThanOrEqual(now),
            },
            select: { id: true },
            take: 50,
            order: { paymentExpiresAt: 'ASC' },
        });
        for (const candidate of candidates) {
            const expired = await this.dataSource.transaction(
                async (manager) => {
                    const orderRepository = manager.getRepository(Order);
                    const order = await orderRepository.findOne({
                        where: { id: candidate.id },
                        lock: { mode: 'pessimistic_write' },
                    });
                    if (
                        !order ||
                        order.status !== OrderStatus.PENDING ||
                        !order.paymentExpiresAt ||
                        order.paymentExpiresAt > now
                    )
                        return null;
                    const attempt = await manager
                        .getRepository(PaymentAttempt)
                        .findOne({
                            where: { orderId: order.id, status: 'PENDING' },
                        });
                    order.status = OrderStatus.CANCELLED;
                    order.fulfillmentStatus =
                        'CANCELLED' as Order['fulfillmentStatus'];
                    order.paymentStatus = PaymentStatus.FAILED;
                    await orderRepository.save(order);
                    await manager.getRepository(OrderStatusHistory).save({
                        orderId: order.id,
                        fromStatus: OrderStatus.PENDING,
                        toStatus: OrderStatus.CANCELLED,
                        reason: 'Hết hạn thanh toán Pay2S sau 15 phút.',
                    });
                    if (attempt) {
                        attempt.status = 'EXPIRED';
                        await manager
                            .getRepository(PaymentAttempt)
                            .save(attempt);
                    }
                    return {
                        order,
                        merchantReference: attempt?.merchantReference ?? null,
                    };
                },
            );
            if (!expired) continue;
            await this.releaseOrderReservation(expired.order);
            if (expired.merchantReference)
                await this.gateway
                    .cancelPayment({
                        orderId: expired.merchantReference,
                        requestId:
                            this.gateway.createMerchantReference('CANCEL'),
                        environment: this.getEnvironment(),
                    })
                    .catch((error: unknown) =>
                        this.logger.warn(
                            `Chưa hủy được link Pay2S của order ${expired.order.id}.`,
                            error instanceof Error ? error.message : undefined,
                        ),
                    );
        }
        const cancelledOrders = await this.dataSource
            .getRepository(Order)
            .find({
                where: [
                    {
                        paymentMethod: PaymentMethod.PAY2S,
                        status: OrderStatus.CANCELLED,
                        paymentStatus: PaymentStatus.FAILED,
                    },
                    {
                        paymentMethod: PaymentMethod.PAY2S,
                        status: OrderStatus.CANCELLED,
                        paymentStatus: PaymentStatus.REFUND_PENDING,
                    },
                    {
                        paymentMethod: PaymentMethod.PAY2S,
                        status: OrderStatus.CANCELLED,
                        paymentStatus: PaymentStatus.REFUNDED,
                    },
                ],
                relations: { items: true },
                take: 50,
                order: { updatedAt: 'ASC' },
            });
        for (const order of cancelledOrders)
            await this.releaseOrderReservation(order);
    }

    // IPN thành công mới mở side effects; repository/client tự bảo vệ idempotency cho callback lặp.
    private async runPaidSideEffects(orderId: string): Promise<void> {
        const order = await this.dataSource.getRepository(Order).findOne({
            where: { id: orderId },
            relations: { items: true },
        });
        if (!order || order.paymentStatus !== PaymentStatus.PAID) return;
        await this.sellerWalletRepository
            .creditOrderPending(order.id)
            .catch((error: unknown) =>
                this.logger.error(
                    `Không ghi được tiền chờ seller sau Pay2S order ${order.id}.`,
                    error instanceof Error ? error.stack : undefined,
                ),
            );
        await this.orderEvents
            .publishCreated(order, order.items ?? [])
            .catch((error: unknown) =>
                this.logger.error(
                    `Không phát được event tạo order sau Pay2S order ${order.id}.`,
                    error instanceof Error ? error.stack : undefined,
                ),
            );
        await this.cartClient
            .checkoutCart(order.ownerId, order.checkoutCartItemId ?? undefined)
            .catch((error: unknown) =>
                this.logger.error(
                    `Không dọn được giỏ sau Pay2S order ${order.id}.`,
                    error instanceof Error ? error.stack : undefined,
                ),
            );
    }

    // Release reservation dùng snapshot order, không nhận item/quantity từ callback provider.
    private async releaseOrderReservation(order: Order): Promise<void> {
        await this.productClient
            .release(
                order.idempotencyKey,
                (order.items ?? []).map((item) => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                })),
            )
            .catch((error: unknown) =>
                this.logger.error(
                    `Không giải phóng được reservation của order ${order.id}.`,
                    error instanceof Error ? error.stack : undefined,
                ),
            );
    }

    // Tạo link và lưu response Pay2S sau network; requestId đã lưu trước call để retry không mất dấu audit.
    private async createPay2sLink(
        order: Order,
        attempt: PaymentAttempt,
    ): Promise<string> {
        const requestId = this.gateway.createMerchantReference('REQ');
        attempt.providerRequestId = requestId;
        await this.dataSource.getRepository(PaymentAttempt).save(attempt);
        const result = await this.gateway.createPayment({
            orderId: attempt.merchantReference,
            requestId,
            amount: order.totalAmount,
            orderInfo: `Thanh toan don ${order.orderNumber}`,
            redirectUrl: this.config.get<string>('PAY2S_RETURN_URL', ''),
            ipnUrl: this.config.get<string>('PAY2S_IPN_URL', ''),
            metadata: this.createOrderMetadata(order),
            environment: attempt.environment,
        });
        attempt.providerOrderInfo = result.orderInfo;
        attempt.providerResponse = result.response;
        await this.dataSource.getRepository(PaymentAttempt).save(attempt);
        return result.payUrl;
    }

    // V2 cần tổng item khớp amount; phí vận chuyển được đưa thành item riêng để không làm lệch snapshot order.
    private createOrderMetadata(order: Order): Pay2sInvoiceMetadata {
        const shipping = order.shippingAddress as Record<string, unknown>;
        const items = (order.items ?? []).map((item) => ({
            externalItemId: item.id,
            itemName: item.productName,
            unit: 'item',
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice),
            taxRate: 0,
        }));
        if (Number(order.shippingFee) > 0)
            items.push({
                externalItemId: `SHIPPING-${order.id}`,
                itemName: 'Phí vận chuyển',
                unit: 'fee',
                quantity: 1,
                unitPrice: Number(order.shippingFee),
                taxRate: 0,
            });
        const total = items.reduce(
            (sum, item) => sum + item.unitPrice * item.quantity,
            0,
        );
        if (total !== Number(order.totalAmount))
            throw new BadRequestException(
                'Snapshot item Pay2S không khớp tổng tiền order.',
            );
        return {
            invoiceType: 'none',
            customerInfo: {
                buyerContactName: this.scalar(shipping.fullName),
                buyerCompanyName: '',
                taxCode: '',
                citizenId: '',
                address: [
                    shipping.street,
                    shipping.ward,
                    shipping.district,
                    shipping.province,
                ]
                    .map((value) => this.scalar(value))
                    .filter(Boolean)
                    .join(', '),
                email: '',
                phone: this.scalar(shipping.phone),
            },
            items,
            invoiceOptions: {
                requested: false,
                buyerNotTakingInvoice: true,
                paymentMethod: 'Chuyển khoản',
                note: '',
                source: 'api',
            },
        };
    }

    // Wallet deposit không có order snapshot; gửi một dòng metadata để amount vẫn khớp contract V2.
    private createWalletMetadata(amount: string): Pay2sInvoiceMetadata {
        return {
            invoiceType: 'none',
            customerInfo: {
                buyerContactName: 'Seller',
                buyerCompanyName: '',
                taxCode: '',
                citizenId: '',
                address: '',
                email: '',
                phone: '',
            },
            items: [
                {
                    externalItemId: 'WALLET_DEPOSIT',
                    itemName: 'Nạp tiền ví seller',
                    unit: 'deposit',
                    quantity: 1,
                    unitPrice: Number(amount),
                    taxRate: 0,
                },
            ],
            invoiceOptions: {
                requested: false,
                buyerNotTakingInvoice: true,
                paymentMethod: 'Chuyển khoản',
                note: '',
                source: 'api',
            },
        };
    }

    // Chỉ chuyển attempt pending sang failed; callback cũ không được ghi đè PAID hoặc refund pending.
    private async markAttemptFailed(
        attemptId: string,
        payload: Pay2sIpnPayload,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(PaymentAttempt);
            const attempt = await repository.findOne({
                where: { id: attemptId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!attempt || attempt.status !== 'PENDING') return;
            attempt.status = 'FAILED';
            attempt.providerOrderInfo = payload.orderInfo;
            attempt.providerResponse = this.redactCallback(payload);
            await repository.save(attempt);
        });
    }

    // Mọi amount Pay2S là VND nguyên; không làm tròn hoặc nhận số âm từ callback.
    private isAmountEqual(value: string | number, expected: string): boolean {
        const actual = Number(String(value));
        const target = Number(expected);
        return (
            Number.isSafeInteger(actual) &&
            Number.isSafeInteger(target) &&
            actual === target
        );
    }

    private getEnvironment(): Pay2sEnvironment {
        return this.config.get<string>('PAY2S_MODE', 'disabled') === 'sandbox'
            ? 'SANDBOX'
            : 'LIVE';
    }

    private scalar(value: unknown): string {
        return typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : '';
    }

    // Chuyển payload Express thành scalar contract; array/object bị loại để không ký/đối chiếu khác dữ liệu.
    private toIpnPayload(
        body: Record<string, unknown>,
    ): Pay2sIpnPayload | null {
        const scalarKeys = [
            'accessKey',
            'amount',
            'extraData',
            'message',
            'orderId',
            'orderInfo',
            'orderType',
            'partnerCode',
            'payType',
            'requestId',
            'responseTime',
            'resultCode',
            'transId',
            'm2signature',
        ] as const;
        if (
            scalarKeys.some(
                (key) =>
                    !(
                        typeof body[key] === 'string' ||
                        typeof body[key] === 'number'
                    ),
            )
        )
            return null;
        return {
            accessKey: String(body.accessKey),
            amount: body.amount as string | number,
            extraData: String(body.extraData),
            message: String(body.message),
            orderId: String(body.orderId),
            orderInfo: String(body.orderInfo),
            orderType: String(body.orderType),
            partnerCode: String(body.partnerCode),
            payType: String(body.payType),
            requestId: body.requestId as string | number,
            requestTrace:
                typeof body.requestTrace === 'string'
                    ? body.requestTrace
                    : undefined,
            responseTime: body.responseTime as string | number,
            resultCode: body.resultCode as string | number,
            transId: String(body.transId),
            m2signature: String(body.m2signature),
        };
    }

    private toRedirectPayload(
        query: Record<string, unknown>,
    ): Pay2sRedirectPayload | null {
        const required = [
            'accessKey',
            'amount',
            'message',
            'orderId',
            'orderInfo',
            'orderType',
            'partnerCode',
            'payType',
            'requestId',
            'responseTime',
            'resultCode',
            'm2signature',
        ] as const;
        if (
            required.some(
                (key) =>
                    !(
                        typeof query[key] === 'string' ||
                        typeof query[key] === 'number'
                    ),
            )
        )
            return null;
        return {
            accessKey: String(query.accessKey),
            amount: query.amount as string | number,
            message: String(query.message),
            orderId: String(query.orderId),
            orderInfo: String(query.orderInfo),
            orderType: String(query.orderType),
            partnerCode: String(query.partnerCode),
            payType: String(query.payType),
            requestId: query.requestId as string | number,
            responseTime: query.responseTime as string | number,
            resultCode: query.resultCode as string | number,
            transId:
                typeof query.transId === 'string' ? query.transId : undefined,
            m2signature: String(query.m2signature),
        };
    }

    // Loại m2signature khỏi dữ liệu lưu để không biến provider response thành bản sao credential proof.
    private redactCallback(payload: Pay2sIpnPayload): Record<string, unknown> {
        const { m2signature: _signature, ...redacted } = payload;
        return redacted;
    }
}
