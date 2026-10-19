// Điều phối payment, chữ ký provider và hậu xử lý order; repository hiện vẫn là điểm cần tách persistence ở lượt refactor riêng.
import {
    BadRequestException,
    ConflictException,
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
import { VnpayGatewayService } from '@/modules/order/application/services/payment/vnpay-gateway.service';
import { CartClient } from '@/modules/order/application/clients/cart.client';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { ProductClient } from '@/modules/order/application/clients/product.client';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { toCents } from '@/modules/order/application/utils/order-money.util';
import { randomUUID } from 'node:crypto';

// Điều phối gateway ngoài transaction DB để timeout provider không giữ khóa order lâu.
@Injectable()
export class PaymentService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PaymentService.name);
    private expirationTimer?: NodeJS.Timeout;
    private expirationRunning = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly config: ConfigService,
        private readonly gateway: VnpayGatewayService,
        private readonly cartClient: CartClient,
        private readonly orderEvents: OrderEventsService,
        private readonly productClient: ProductClient,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly sellerWalletRepository: SellerWalletRepositoryPort,
    ) {}

    // Gắn dấu nguồn VNPay Sandbox lên order để đối soát; cờ này không thay đổi nghiệp vụ sau khi payment được xác minh.
    isSandboxMode(): boolean {
        return this.config.get<string>('VNPAY_MODE', 'disabled') === 'sandbox';
    }

    // Chặn checkout trước khi order-service gọi cart, quote GHN hoặc reserve tồn kho.
    assertVnpayCheckoutAllowed(): void {
        this.gateway.assertCheckoutEnabled();
    }

    // Quét các order VNPay quá hạn theo batch nhỏ để không giữ reservation vô thời hạn sau khi khách bỏ checkout.
    onModuleInit(): void {
        this.expirationTimer = setInterval(
            () =>
                void this.expirePendingOrders().catch((error: unknown) =>
                    this.logger.error(
                        'Không quét được order VNPay hết hạn.',
                        error instanceof Error ? error.stack : undefined,
                    ),
                ),
            30_000,
        );
        void this.expirePendingOrders().catch((error: unknown) =>
            this.logger.error(
                'Không quét được order VNPay hết hạn lúc khởi động.',
                error instanceof Error ? error.stack : undefined,
            ),
        );
    }

    // Dừng timer để service shutdown và unit test không giữ process mở.
    onModuleDestroy(): void {
        if (this.expirationTimer) clearInterval(this.expirationTimer);
    }

    // Chỉ tạo attempt cho order còn chờ tiền; URL và attempt cùng dùng snapshot amount, expiry và môi trường đã chốt.
    // Retry sẽ nhận lại attempt đang chờ, còn unique violation do hai request đồng thời sẽ được giải quyết bằng cách đọc lại.
    // Provider chỉ được gọi sau khi các giá trị đã hợp lệ; bí mật ký số không rời service này.
    async startVnpayPayment(
        order: Order,
        ipAddress: string,
    ): Promise<{ paymentUrl: string; attempt: PaymentAttempt }> {
        if (
            order.paymentMethod !== PaymentMethod.VNPAY ||
            order.paymentStatus !== PaymentStatus.PENDING
        ) {
            throw new BadRequestException(
                'Đơn hàng không ở trạng thái chờ thanh toán VNPay.',
            );
        }
        const mode = this.config.get<string>('VNPAY_MODE', 'disabled');
        const environment = mode === 'sandbox' ? 'SANDBOX' : 'LIVE';
        const expiresAt =
            order.paymentExpiresAt ?? new Date(Date.now() + 15 * 60_000);
        const existing = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({
                where: { orderId: order.id, status: 'PENDING' },
            });
        if (existing) {
            if (existing.expiresAt <= new Date())
                throw new BadRequestException('Phiên thanh toán đã hết hạn.');
            return {
                attempt: existing,
                paymentUrl: this.createPaymentUrl(
                    order,
                    existing.merchantReference,
                    ipAddress,
                    existing.providerCreateDate,
                ),
            };
        }

        const merchantReference = this.gateway.createMerchantReference();
        const providerCreateDate = this.gateway.formatVnpayTimestamp(
            new Date(),
        );
        const paymentUrl = this.createPaymentUrl(
            order,
            merchantReference,
            ipAddress,
            providerCreateDate,
        );
        const attempt = this.dataSource.getRepository(PaymentAttempt).create({
            orderId: order.id,
            merchantReference,
            providerTransactionId: null,
            status: 'PENDING',
            environment,
            amount: order.totalAmount,
            currency: 'VND',
            expiresAt,
            providerCreateDate,
            confirmedAt: null,
            refundRequestId: null,
            providerResponse: null,
        });
        try {
            await this.dataSource.getRepository(PaymentAttempt).save(attempt);
        } catch (error) {
            // Unique index cho phép chỉ một attempt PENDING/order; nếu request khác thắng race thì dùng lại attempt đó.
            const databaseCode = (error as { code?: string }).code;
            if (databaseCode !== '23505') throw error;
            const concurrentAttempt = await this.dataSource
                .getRepository(PaymentAttempt)
                .findOne({
                    where: { orderId: order.id, status: 'PENDING' },
                });
            if (!concurrentAttempt || concurrentAttempt.expiresAt <= new Date())
                throw error;
            return {
                attempt: concurrentAttempt,
                paymentUrl: this.createPaymentUrl(
                    order,
                    concurrentAttempt.merchantReference,
                    ipAddress,
                    concurrentAttempt.providerCreateDate,
                ),
            };
        }
        return { paymentUrl, attempt };
    }

    // Ghi nhận remittance COD sau khi đối soát admin; repository chuyển tiền hàng sang pending bằng ledger idempotent.
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

    // Admin xác nhận COD đã hoàn bằng phương thức ngoài hệ thống; backend không tự chuyển tiền.
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

    // Tạo giao dịch nạp ví bằng mã riêng; URL luôn ký bằng thông tin Sandbox và chỉ IPN mới ghi có.
    async createWalletDeposit(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        ipAddress: string;
    }) {
        // VNPay giao dịch VND nguyên; validate trước khi ký URL hoặc tạo bản ghi nạp để không sinh phiên mồ côi.
        const amount = Number(input.amount);
        if (
            !Number.isSafeInteger(amount) ||
            amount < 10_000 ||
            amount > 1_000_000_000
        ) {
            throw new BadRequestException(
                'Số tiền nạp phải từ 10.000 đến 1.000.000.000 đồng.',
            );
        }
        const merchantReference = `W${this.gateway.createMerchantReference()}`;
        const expiresAt = new Date(Date.now() + 15 * 60_000);
        const paymentUrl = this.gateway.createSandboxPaymentUrl({
            merchantReference,
            amount: input.amount,
            orderInfo: 'Nap tien vi seller',
            ipAddress: input.ipAddress,
            expiresAt,
            returnUrl: this.config.get<string>('VNPAY_WALLET_RETURN_URL', ''),
        });
        const deposit = await this.sellerWalletRepository.createWalletDeposit({
            shopId: input.shopId,
            sellerUserId: input.sellerUserId,
            amount: input.amount,
            merchantReference,
            expiresAt,
        });
        return { deposit, paymentUrl };
    }

    // Tự gửi hoàn VNPay cho return đã kiểm tra ở đúng môi trường LIVE/Sandbox của attempt; giữ request ID qua timeout để không hoàn trùng.
    async refundVnpayReturn(
        returnRequestId: string,
        requestedBy = 'system',
    ): Promise<void> {
        const returnRepository =
            this.dataSource.getRepository(OrderReturnRequest);
        const request = await returnRepository.findOne({
            where: { id: returnRequestId },
        });
        if (
            request?.status === OrderReturnStatus.REFUNDED &&
            request.refundMethod === 'VNPAY'
        ) {
            await this.sellerWalletRepository.reverseRefund(returnRequestId);
            return;
        }
        if (
            !request ||
            ![
                OrderReturnStatus.REFUND_PENDING,
                OrderReturnStatus.REFUND_FAILED,
            ].includes(request.status)
        )
            return;
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { id: request.orderId } });
        if (!order || order.paymentMethod !== PaymentMethod.VNPAY) return;
        // Lấy callback đã xác thực để dùng PayDate gốc; providerCreateDate là thời điểm tạo trang checkout, không phải ngày giao dịch.
        const attempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .createQueryBuilder('attempt')
            .addSelect('attempt.providerResponse')
            .where('attempt.order_id = :orderId', { orderId: order.id })
            .andWhere('attempt.status = :status', { status: 'PAID' })
            .orderBy('attempt.created_at', 'DESC')
            .getOne();
        if (!attempt?.providerTransactionId)
            throw new BadRequestException(
                'Thiếu mã giao dịch VNPay gốc để hoàn tiền.',
            );
        const originalPaymentDate = attempt.providerResponse?.vnp_PayDate;
        if (
            typeof originalPaymentDate !== 'string' ||
            !/^\d{14}$/.test(originalPaymentDate)
        ) {
            throw new ConflictException(
                'Thiếu ngày thanh toán VNPay gốc để hoàn tiền an toàn.',
            );
        }

        const requestedAmount = toCents(request.refundAmount);
        const lockedRequest = await this.dataSource.transaction(
            async (manager) => {
                const lockedOrder = await manager.getRepository(Order).findOne({
                    where: { id: order.id },
                    lock: { mode: 'pessimistic_write' },
                });
                if (!lockedOrder)
                    throw new NotFoundException('Không tìm thấy đơn hàng.');
                const locked = await manager
                    .getRepository(OrderReturnRequest)
                    .findOne({
                        where: { id: request.id },
                        lock: { mode: 'pessimistic_write' },
                    });
                if (
                    !locked ||
                    ![
                        OrderReturnStatus.REFUND_PENDING,
                        OrderReturnStatus.REFUND_FAILED,
                    ].includes(locked.status)
                )
                    return null;
                const previousRefunds = await manager
                    .getRepository(OrderReturnRequest)
                    .createQueryBuilder('return_request')
                    .select(
                        'COALESCE(SUM(return_request.refund_amount), 0)',
                        'amount',
                    )
                    .where('return_request.order_id = :orderId', {
                        orderId: order.id,
                    })
                    .andWhere('return_request.status IN (:...statuses)', {
                        statuses: [
                            OrderReturnStatus.REFUNDED,
                            OrderReturnStatus.REFUND_PENDING,
                        ],
                    })
                    .andWhere('return_request.id <> :returnId', {
                        returnId: locked.id,
                    })
                    .getRawOne<{ amount: string }>();
                if (
                    toCents(previousRefunds?.amount ?? '0') + requestedAmount >
                    toCents(lockedOrder.totalAmount)
                ) {
                    throw new ConflictException(
                        'Tổng các khoản hoàn vượt số tiền đã thanh toán.',
                    );
                }
                const isConfirmedFailureRetry =
                    locked.status === OrderReturnStatus.REFUND_FAILED;
                locked.status = OrderReturnStatus.REFUND_PENDING;
                locked.refundMethod = 'VNPAY';
                if (isConfirmedFailureRetry || !locked.refundRequestId) {
                    locked.refundRequestId = randomUUID()
                        .replaceAll('-', '')
                        .toUpperCase();
                    locked.refundProof = null;
                }
                await manager.getRepository(OrderReturnRequest).save(locked);
                return locked;
            },
        );
        if (!lockedRequest?.refundRequestId) return;

        let response: Record<string, string>;
        try {
            response = await this.gateway.refund({
                requestId: lockedRequest.refundRequestId,
                merchantReference: attempt.merchantReference,
                transactionId: attempt.providerTransactionId,
                transactionDate: originalPaymentDate,
                amount: lockedRequest.refundAmount,
                originalAmount: order.totalAmount,
                createBy: requestedBy,
                orderInfo: `Hoan tien don ${order.orderNumber}`,
                environment: attempt.environment,
            });
        } catch {
            // Timeout/lỗi mạng chưa xác định được kết quả nên giữ REFUND_PENDING và cùng request ID.
            return;
        }
        await this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(OrderReturnRequest);
            const locked = await repository.findOne({
                where: { id: lockedRequest.id },
                lock: { mode: 'pessimistic_write' },
            });
            if (!locked || locked.status !== OrderReturnStatus.REFUND_PENDING)
                return;
            locked.refundProof = response;
            if (
                response.vnp_ResponseCode === '00' &&
                response.vnp_TransactionStatus === '00'
            ) {
                locked.status = OrderReturnStatus.REFUNDED;
                locked.refundTransactionReference =
                    response.vnp_TransactionNo ?? null;
                locked.refundProcessedBy = requestedBy;
                locked.refundProcessedAt = new Date();
            } else if (
                response.vnp_ResponseCode &&
                !['94', '99'].includes(response.vnp_ResponseCode)
            ) {
                locked.status = OrderReturnStatus.REFUND_FAILED;
            }
            await repository.save(locked);
            const refundedAmount = await repository
                .createQueryBuilder('return_request')
                .select(
                    'COALESCE(SUM(return_request.refund_amount), 0)',
                    'amount',
                )
                .where('return_request.order_id = :orderId', {
                    orderId: order.id,
                })
                .andWhere('return_request.status = :status', {
                    status: OrderReturnStatus.REFUNDED,
                })
                .getRawOne<{ amount: string }>();
            if (
                toCents(refundedAmount?.amount ?? '0') >=
                toCents(order.totalAmount)
            ) {
                await manager
                    .getRepository(Order)
                    .update(order.id, {
                        paymentStatus: PaymentStatus.REFUNDED,
                    });
            }
        });
        if (
            response.vnp_ResponseCode === '00' &&
            response.vnp_TransactionStatus === '00'
        ) {
            await this.sellerWalletRepository.reverseRefund(returnRequestId);
        }
    }

    // Chỉ finance admin được gọi retry sau khi provider đã trả thất bại rõ ràng; timeout giữ nguyên requestId cũ.
    async retryVnpayRefund(
        returnRequestId: string,
        adminId: string,
    ): Promise<void> {
        if (!adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.refundVnpayReturn(returnRequestId, adminId);
    }

    // Xác minh chữ ký và merchant reference trước khi xét dữ liệu tiền để chỉ callback có nguồn gốc VNPay mới được xử lý.
    // Amount luôn phải khớp snapshot; CurrCode không có trong response PAY chuẩn nên chỉ kiểm tra khi provider thật sự gửi.
    // Sau các kiểm tra này, transaction khóa attempt/order và cập nhật idempotent; callback sai không đổi trạng thái.
    async processVnpayIpn(
        query: Record<string, unknown>,
    ): Promise<{ RspCode: string; Message: string }> {
        const params = this.toStringParams(query);
        const merchantReference = params.vnp_TxnRef;
        if (!merchantReference)
            return { RspCode: '01', Message: 'Order not found' };
        const attempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({
                where: { merchantReference },
            });
        if (!attempt)
            return this.processWalletDepositIpn(
                params,
                query,
                merchantReference,
            );
        if (!this.gateway.verifyCallback(params, attempt.environment)) {
            // Không ghi raw query/chữ ký vào log; dùng ID attempt nội bộ để tránh đưa dữ liệu tùy ý vào log.
            this.logger.warn(
                `VNPay IPN bị từ chối do chữ ký không hợp lệ. attemptId=${attempt.id}`,
            );
            return { RspCode: '97', Message: 'Invalid signature' };
        }

        // VNPay gửi tiền theo đơn vị 1/100 VND; chỉ chấp nhận số nguyên đúng snapshot đã lưu ở attempt.
        const callbackAmountText = params.vnp_Amount ?? '';
        if (
            !/^\d+$/.test(callbackAmountText) ||
            !Number.isSafeInteger(Number(callbackAmountText))
        ) {
            // Từ chối số tiền không nguyên/an toàn trước mọi transaction để tránh làm tròn sai giao dịch.
            this.logger.warn(
                `VNPay IPN có amount sai định dạng. attemptId=${attempt.id}`,
            );
            return { RspCode: '04', Message: 'Invalid amount format' };
        }
        const callbackAmount = Number(callbackAmountText);
        const expectedAmount = Math.round(Number(attempt.amount) * 100);
        if (
            !Number.isSafeInteger(expectedAmount) ||
            callbackAmount !== expectedAmount
        ) {
            // VNPay trả amount theo đơn vị 1/100 VND; không dùng số tiền từ trình duyệt hoặc tính lại từ giá hiện thời.
            this.logger.warn(
                `VNPay IPN không khớp amount của snapshot. attemptId=${attempt.id}`,
            );
            return { RspCode: '04', Message: 'Invalid amount' };
        }

        // Response PAY chuẩn của VNPay không có vnp_CurrCode; currency của attempt vẫn là nguồn authoritative.
        // Nếu callback có trường này, chỉ chấp nhận giá trị scalar khớp snapshot; array/null/giá trị lạ đều bị từ chối.
        if (
            query.vnp_CurrCode !== undefined &&
            (typeof query.vnp_CurrCode !== 'string' ||
                query.vnp_CurrCode !== attempt.currency)
        ) {
            this.logger.warn(
                `VNPay IPN không khớp currency của snapshot. attemptId=${attempt.id}`,
            );
            return { RspCode: '04', Message: 'Invalid currency' };
        }
        if (
            params.vnp_ResponseCode !== '00' ||
            params.vnp_TransactionStatus !== '00'
        ) {
            await this.markAttemptFailed(attempt.id, params);
            return { RspCode: '00', Message: 'Confirm Success' };
        }
        if (!/^\d{1,15}$/.test(params.vnp_TransactionNo ?? '')) {
            // TransactionNo là bằng chứng đối soát bắt buộc; PayDate chỉ được dùng cho refund nên không chặn ghi nhận tiền.
            this.logger.warn(
                `VNPay IPN thiếu mã giao dịch hợp lệ. attemptId=${attempt.id}`,
            );
            return { RspCode: '04', Message: 'Invalid transaction reference' };
        }
        if (!/^\d{14}$/.test(params.vnp_PayDate ?? '')) {
            // Tài liệu VNPay quy định PayDate 14 chữ số; callback có chữ ký vẫn xác nhận được khoản thu,
            // nhưng không đủ dữ liệu chuẩn để gọi refund tự động nên giữ nguyên giá trị gốc để đối soát.
            this.logger.warn(
                `VNPay xác nhận tiền nhưng PayDate không đúng 14 chữ số; cần đối soát trước khi hoàn. orderId=${attempt.orderId}`,
            );
        }

        const outcome = await this.dataSource.transaction(async (manager) => {
            const attemptRepository = manager.getRepository(PaymentAttempt);
            const lockedAttempt = await attemptRepository.findOne({
                where: { id: attempt.id },
                lock: { mode: 'pessimistic_write' },
            });
            if (!lockedAttempt)
                throw new NotFoundException('Không tìm thấy giao dịch.');
            if (lockedAttempt.status === 'PAID') {
                return lockedAttempt.providerTransactionId ===
                    params.vnp_TransactionNo
                    ? ('duplicate' as const)
                    : ('not-pending' as const);
            }
            // Callback lặp của khoản đã đưa vào hàng hoàn phải ACK; retrying IPN không được tạo thêm payment hay trả lỗi giả.
            if (
                lockedAttempt.status === 'REFUND_PENDING' ||
                lockedAttempt.status === 'REFUNDED'
            ) {
                return lockedAttempt.providerTransactionId ===
                    params.vnp_TransactionNo
                    ? ('late-payment' as const)
                    : ('not-pending' as const);
            }
            if (
                !['PENDING', 'EXPIRED', 'FAILED'].includes(lockedAttempt.status)
            )
                return 'not-pending' as const;
            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository.findOne({
                where: { id: lockedAttempt.orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!order) throw new NotFoundException('Không tìm thấy đơn hàng.');

            // Một order chỉ giao theo một payment; nếu một attempt khác đã thu tiền thì khoản thu mới là khoản thừa cần hoàn.
            const anotherAttemptPaid = await attemptRepository
                .createQueryBuilder('attempt')
                .where('attempt.order_id = :orderId', { orderId: order.id })
                .andWhere('attempt.status = :status', { status: 'PAID' })
                .andWhere('attempt.id <> :attemptId', {
                    attemptId: lockedAttempt.id,
                })
                .getExists();

            lockedAttempt.providerTransactionId =
                params.vnp_TransactionNo || null;
            lockedAttempt.providerResponse = this.redactCallback(params);
            lockedAttempt.confirmedAt = new Date();
            if (
                anotherAttemptPaid ||
                lockedAttempt.status !== 'PENDING' ||
                lockedAttempt.expiresAt <= new Date() ||
                order.status !== OrderStatus.PENDING
            ) {
                // Attempt thất bại/hết hạn hoặc order đã chốt bằng attempt khác không được chuyển order sang giao hàng.
                lockedAttempt.status = 'REFUND_PENDING';
                // Chỉ hủy order nếu chưa có khoản thanh toán hợp lệ; order đã được thanh toán khác phải giữ nguyên trạng thái.
                if (
                    !anotherAttemptPaid &&
                    order.paymentStatus !== PaymentStatus.PAID
                ) {
                    const previousStatus = order.status;
                    order.paymentStatus = PaymentStatus.REFUND_PENDING;
                    order.status = OrderStatus.CANCELLED;
                    order.fulfillmentStatus =
                        'CANCELLED' as Order['fulfillmentStatus'];
                    if (previousStatus !== OrderStatus.CANCELLED) {
                        await manager.getRepository(OrderStatusHistory).save({
                            orderId: order.id,
                            fromStatus: previousStatus,
                            toStatus: OrderStatus.CANCELLED,
                            reason: 'Hủy vì thanh toán VNPay đến muộn; chờ hoàn giao dịch.',
                        });
                    }
                }
                await attemptRepository.save(lockedAttempt);
                await orderRepository.save(order);
                return 'late-payment' as const;
            }

            lockedAttempt.status = 'PAID';
            // Lịch sử trạng thái order phải đổi cùng payment attempt để customer/seller không thấy hai nguồn sự thật khác nhau.
            const previousStatus = order.status;
            order.paymentStatus = PaymentStatus.PAID;
            order.status = OrderStatus.CONFIRMED;
            await attemptRepository.save(lockedAttempt);
            await orderRepository.save(order);
            await manager.getRepository(OrderStatusHistory).save({
                orderId: order.id,
                fromStatus: previousStatus,
                toStatus: OrderStatus.CONFIRMED,
                reason: 'VNPay xác nhận thanh toán qua callback đã ký.',
            });
            return 'paid' as const;
        });
        if (outcome === 'not-pending')
            return { RspCode: '02', Message: 'Order already confirmed' };
        if (outcome === 'paid' || outcome === 'duplicate') {
            const order = await this.dataSource.getRepository(Order).findOne({
                where: { id: attempt.orderId },
                relations: { items: true },
            });
            if (order?.paymentStatus === PaymentStatus.PAID) {
                // Sandbox chỉ khác ở nguồn tiền; khi callback chữ ký hợp lệ, giữ tồn kho và chạy cùng hậu xử lý với giao dịch LIVE.
                // Từng side effect vẫn idempotent hoặc best-effort để callback lặp không cộng ví, gửi event hay dọn giỏ hai lần.
                await this.sellerWalletRepository
                    .creditOrderPending(order.id)
                    .catch((error: unknown) => {
                        this.logger.error(
                            `Không ghi được tiền chờ seller sau thanh toán order ${order.id}.`,
                            error instanceof Error ? error.stack : undefined,
                        );
                    });
                await this.orderEvents
                    .publishCreated(order, order.items ?? [])
                    .catch((error: unknown) => {
                        this.logger.error(
                            `Không phát được event tạo order sau thanh toán order ${order.id}.`,
                            error instanceof Error ? error.stack : undefined,
                        );
                    });
                await this.cartClient
                    .checkoutCart(
                        order.ownerId,
                        order.checkoutCartItemId ?? undefined,
                    )
                    .catch((error: unknown) => {
                        this.logger.error(
                            `Không dọn được giỏ sau thanh toán order ${order.id}.`,
                            error instanceof Error ? error.stack : undefined,
                        );
                    });
            }
        }
        if (outcome === 'late-payment') {
            // Chỉ nhả stock nếu order đã bị hủy vì không có payment hợp lệ; payment thừa không được tác động order đang bán.
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
            await this.refundLatePayment(attempt.id);
        }
        return { RspCode: '00', Message: 'Confirm Success' };
    }

    // Dùng cùng bộ xác minh chữ ký và cập nhật idempotent như IPN; browser không được tự quyết định giao dịch thành công.
    // Chỉ trạng thái PAID mới kèm orderId từ attempt đã lưu để UI mở đúng đơn; callback không cung cấp đích điều hướng authoritative.
    // Mọi trạng thái khác không có orderId, còn lỗi xác minh trả UNVERIFIED để tránh hiển thị nhầm biên nhận.
    async processVnpayReturn(query: Record<string, unknown>): Promise<
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
          }
    > {
        const params = this.toStringParams(query);
        if (!params.vnp_TxnRef) return { status: 'UNVERIFIED' };
        const callbackResult = await this.processVnpayIpn(query);

        // Mã phản hồi khác 00 bao gồm sai chữ ký, sai số tiền hoặc order không tồn tại; không dùng dữ liệu browser để báo thành công.
        if (callbackResult.RspCode !== '00') return { status: 'UNVERIFIED' };

        const attempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({
                where: { merchantReference: params.vnp_TxnRef },
            });
        if (!attempt) {
            const deposit =
                await this.sellerWalletRepository.getWalletDepositByReference(
                    params.vnp_TxnRef,
                );
            if (!deposit) return { status: 'UNVERIFIED' };
            if (
                deposit.status === 'PAID' &&
                deposit.providerTransactionId === params.vnp_TransactionNo
            ) {
                return { status: 'WALLET_DEPOSIT_PAID', depositId: deposit.id };
            }
            if (deposit.status === 'FAILED')
                return { status: 'WALLET_DEPOSIT_FAILED' };
            return { status: 'PENDING' };
        }

        // PAID chỉ hợp lệ nếu chính transaction ID vừa ký được lưu trên attempt; callback cũ/khác giao dịch không được nhận nhầm.
        if (
            attempt.status === 'PAID' &&
            attempt.providerTransactionId === params.vnp_TransactionNo
        ) {
            // orderId lấy từ attempt tìm bằng merchant reference đã ký và transaction ID vừa đối chiếu.
            return { status: 'PAID', orderId: attempt.orderId };
        }
        if (attempt.status === 'REFUND_PENDING')
            return { status: 'REFUND_PENDING' };
        if (attempt.status === 'REFUNDED') return { status: 'REFUNDED' };
        if (attempt.status === 'FAILED') return { status: 'FAILED' };
        return { status: 'PENDING' };
    }

    // Xử lý IPN nạp ví sau khi không tìm thấy order attempt; mọi dữ liệu tiền và shop lấy từ bản ghi đã lưu.
    private async processWalletDepositIpn(
        params: Record<string, string>,
        query: Record<string, unknown>,
        merchantReference: string,
    ): Promise<{ RspCode: string; Message: string }> {
        const deposit =
            await this.sellerWalletRepository.getWalletDepositByReference(
                merchantReference,
            );
        if (!deposit) return { RspCode: '01', Message: 'Order not found' };
        if (!this.gateway.verifyCallback(params, 'SANDBOX')) {
            this.logger.warn(
                `VNPay wallet IPN sai chữ ký. depositId=${deposit.id}`,
            );
            return { RspCode: '97', Message: 'Invalid signature' };
        }
        const amountText = params.vnp_Amount ?? '';
        const expectedAmount = Math.round(Number(deposit.amount) * 100);
        if (
            !/^\d+$/.test(amountText) ||
            !Number.isSafeInteger(Number(amountText)) ||
            Number(amountText) !== expectedAmount
        ) {
            return { RspCode: '04', Message: 'Invalid amount' };
        }
        if (
            params.vnp_ResponseCode !== '00' ||
            params.vnp_TransactionStatus !== '00'
        ) {
            await this.sellerWalletRepository.failWalletDeposit(
                deposit.id,
                this.redactCallback(params),
            );
            return { RspCode: '00', Message: 'Confirm Success' };
        }
        if (!/^\d{1,15}$/.test(params.vnp_TransactionNo ?? ''))
            return { RspCode: '04', Message: 'Invalid transaction reference' };
        if (query.vnp_CurrCode !== undefined && query.vnp_CurrCode !== 'VND')
            return { RspCode: '04', Message: 'Invalid currency' };
        const outcome = await this.sellerWalletRepository.confirmWalletDeposit({
            depositId: deposit.id,
            transactionId: params.vnp_TransactionNo!,
            providerResponse: this.redactCallback(params),
        });
        if (outcome === 'NOT_PENDING')
            return { RspCode: '02', Message: 'Deposit already processed' };
        return { RspCode: '00', Message: 'Confirm Success' };
    }

    // Chạy timeout payment theo batch để giới hạn áp lực DB; row lock làm callback và expiry chọn đúng một nhánh thắng cuộc.
    // Sau commit, side effect tồn kho/provider chạy ngoài transaction để không giữ khóa trong lúc gọi network.
    private async expirePendingOrders(): Promise<void> {
        // Interval có thể chạy lại khi batch trước còn chờ network; bỏ qua lượt chồng trong cùng replica.
        if (this.expirationRunning) return;
        this.expirationRunning = true;
        try {
            await this.runExpirationPass();
        } finally {
            this.expirationRunning = false;
        }
    }

    // Xử lý một lượt hết hạn, hoàn muộn và thử lại nhả reservation theo từng batch giới hạn.
    private async runExpirationPass(): Promise<void> {
        const now = new Date();
        const candidates = await this.dataSource.getRepository(Order).find({
            where: {
                paymentMethod: PaymentMethod.VNPAY,
                status: OrderStatus.PENDING,
                paymentExpiresAt: LessThanOrEqual(now),
            },
            select: { id: true },
            take: 50,
            order: { paymentExpiresAt: 'ASC' },
        });
        for (const candidate of candidates) {
            const expiredOrderId = await this.dataSource.transaction(
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
                    ) {
                        return null;
                    }
                    const previousStatus = order.status;
                    order.status = OrderStatus.CANCELLED;
                    order.fulfillmentStatus =
                        'CANCELLED' as Order['fulfillmentStatus'];
                    order.paymentStatus = PaymentStatus.FAILED;
                    await orderRepository.save(order);
                    // Thêm một audit row trong cùng transaction để timeout không chỉ đổi cột mà mất lý do chuyển trạng thái.
                    await manager.getRepository(OrderStatusHistory).save({
                        orderId: order.id,
                        fromStatus: previousStatus,
                        toStatus: OrderStatus.CANCELLED,
                        reason: 'Hết hạn thanh toán VNPay sau 15 phút.',
                    });
                    await manager
                        .getRepository(PaymentAttempt)
                        .createQueryBuilder()
                        .update(PaymentAttempt)
                        .set({ status: 'EXPIRED' })
                        .where('order_id = :orderId AND status = :status', {
                            orderId: order.id,
                            status: 'PENDING',
                        })
                        .execute();
                    // Chỉ trả ID khỏi transaction; không join collection khi đang giữ FOR UPDATE trên bảng order.
                    return order.id;
                },
            );
            if (expiredOrderId) {
                // Nạp snapshot items sau commit để release tồn kho mà không khóa nullable side của LEFT JOIN.
                const expiredOrder = await this.dataSource
                    .getRepository(Order)
                    .findOne({
                        where: { id: expiredOrderId },
                        relations: { items: true },
                    });
                if (expiredOrder) {
                    await this.releaseOrderReservation(expiredOrder);
                }
            }
        }
        // Các khoản hoàn chưa rõ kết quả được thử lại bằng cùng request ID; provider phải xác định trùng request idempotently.
        const latePayments = await this.dataSource
            .getRepository(PaymentAttempt)
            .createQueryBuilder('attempt')
            .select(['attempt.id', 'attempt.orderId'])
            .where('attempt.status = :status', { status: 'REFUND_PENDING' })
            .orderBy('attempt.created_at', 'ASC')
            .take(50)
            .getMany();
        for (const attempt of latePayments) {
            await this.refundLatePayment(attempt.id);
        }
        // Retry reservation release đã lỗi mạng ở lần trước; endpoint Product dùng reservationKey idempotent.
        const cancelledOrders = await this.dataSource
            .getRepository(Order)
            .find({
                where: [
                    {
                        paymentMethod: PaymentMethod.VNPAY,
                        status: OrderStatus.CANCELLED,
                        paymentStatus: PaymentStatus.FAILED,
                    },
                    {
                        paymentMethod: PaymentMethod.VNPAY,
                        status: OrderStatus.CANCELLED,
                        paymentStatus: PaymentStatus.REFUND_PENDING,
                    },
                    {
                        paymentMethod: PaymentMethod.VNPAY,
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

    // Release chỉ dùng reservationKey và snapshot variant/quantity đã lưu, không nhận dữ liệu từ callback.
    private async releaseOrderReservation(order: Order): Promise<void> {
        await this.productClient
            .release(
                order.idempotencyKey,
                (order.items ?? []).map((item) => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                })),
            )
            .catch((error: unknown) => {
                this.logger.error(
                    `Không giải phóng được reservation của order ${order.id}.`,
                    error instanceof Error ? error.stack : undefined,
                );
            });
    }

    // Tự hoàn khoản thu đến sau khi order đã hủy; cùng request ID được lưu trước gọi provider để callback/job retry không nhân đôi lệnh.
    private async refundLatePayment(attemptId: string): Promise<void> {
        const locked = await this.dataSource.transaction(async (manager) => {
            const attemptRepository = manager.getRepository(PaymentAttempt);
            const attempt = await attemptRepository
                .createQueryBuilder('attempt')
                .addSelect('attempt.providerResponse')
                .setLock('pessimistic_write')
                .where('attempt.id = :attemptId', { attemptId })
                .getOne();
            if (
                !attempt ||
                attempt.status !== 'REFUND_PENDING' ||
                !attempt.providerTransactionId
            )
                return null;
            const response = attempt.providerResponse ?? {};
            const transactionDate =
                typeof response.vnp_PayDate === 'string'
                    ? response.vnp_PayDate
                    : '';
            // Query/refund của VNPay yêu cầu ngày gốc đúng yyyyMMddHHmmss; dữ liệu lệch định dạng cần đối soát thủ công.
            if (!/^\d{14}$/.test(transactionDate)) return null;
            attempt.refundRequestId ??= randomUUID()
                .replaceAll('-', '')
                .toUpperCase();
            await attemptRepository.save(attempt);
            return {
                id: attempt.id,
                orderId: attempt.orderId,
                merchantReference: attempt.merchantReference,
                transactionId: attempt.providerTransactionId,
                transactionDate,
                amount: attempt.amount,
                requestId: attempt.refundRequestId,
                environment: attempt.environment,
            };
        });
        if (!locked) return;

        let response: Record<string, string>;
        try {
            response = await this.gateway.refund({
                merchantReference: locked.merchantReference,
                transactionId: locked.transactionId,
                transactionDate: locked.transactionDate,
                amount: locked.amount,
                originalAmount: locked.amount,
                requestId: locked.requestId,
                createBy: 'BIN_SYSTEM',
                orderInfo: `Hoan tien order ${locked.orderId} thanh toan tre`,
                environment: locked.environment,
            });
        } catch (error) {
            // Lỗi mạng/kết quả chưa rõ vẫn giữ REFUND_PENDING và request ID để job định kỳ thử lại an toàn.
            this.logger.warn(
                `Chưa xác nhận được hoàn VNPay muộn cho attempt ${locked.id}.`,
                error instanceof Error ? error.message : undefined,
            );
            return;
        }
        if (
            response.vnp_ResponseCode !== '00' ||
            response.vnp_TransactionStatus !== '00'
        )
            return;

        await this.dataSource.transaction(async (manager) => {
            const attemptRepository = manager.getRepository(PaymentAttempt);
            const attempt = await attemptRepository.findOne({
                where: { id: locked.id },
                lock: { mode: 'pessimistic_write' },
            });
            if (!attempt || attempt.status !== 'REFUND_PENDING') return;
            attempt.status = 'REFUNDED';
            attempt.providerResponse = {
                ...(attempt.providerResponse ?? {}),
                refundResponse: response,
            };
            await attemptRepository.save(attempt);
            // Nếu đây là khoản thu thừa trên order đã thanh toán bằng attempt khác, không ghi đè trạng thái order đó.
            await manager
                .getRepository(Order)
                .createQueryBuilder()
                .update(Order)
                .set({ paymentStatus: PaymentStatus.REFUNDED })
                .where('id = :orderId AND payment_status = :pendingStatus', {
                    orderId: locked.orderId,
                    pendingStatus: PaymentStatus.REFUND_PENDING,
                })
                .execute();
        });
    }

    // Cấp URL dựa trên amount đã chốt và giữ callback không có quyền tự đổi merchant/order amount.
    private createPaymentUrl(
        order: Order,
        reference: string,
        ipAddress: string,
        createdAt?: string,
    ): string {
        return this.gateway.createPaymentUrl({
            merchantReference: reference,
            amount: order.totalAmount,
            orderInfo: `Thanh toan don ${order.orderNumber}`,
            ipAddress,
            expiresAt: order.paymentExpiresAt ?? undefined,
            ...(createdAt ? { createdAt } : {}),
        });
    }

    // Chỉ chuyển attempt đang chờ sang FAILED; callback cũ không được phép ghi đè PAID, EXPIRED hoặc trạng thái hoàn.
    private async markAttemptFailed(
        attemptId: string,
        params: Record<string, string>,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(PaymentAttempt);
            const attempt = await repository.findOne({
                where: { id: attemptId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!attempt || attempt.status !== 'PENDING') return;
            attempt.status = 'FAILED';
            attempt.providerResponse = this.redactCallback(params);
            await repository.save(attempt);
        });
    }

    // Giới hạn callback vào scalar string để array/object lạ không vượt qua so sánh amount hoặc ký số khác nhau.
    private toStringParams(
        query: Record<string, unknown>,
    ): Record<string, string> {
        const params: Record<string, string> = {};
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'string' || typeof value === 'number')
                params[key] = String(value);
        }
        return params;
    }

    // Lưu tập dữ liệu callback tối thiểu, bỏ chữ ký để giảm nguy cơ lộ dữ liệu xác thực trong log/DB.
    private redactCallback(
        params: Record<string, string>,
    ): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(params).filter(
                ([key]) =>
                    key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType',
            ),
        );
    }
}
