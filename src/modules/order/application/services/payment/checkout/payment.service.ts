// Điều phối checkout Pay2S, IPN/redirect và hậu xử lý order; provider adapter giữ riêng HTTP/chữ ký.
import {
    BadRequestException,
    Injectable,
    Inject,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import { Pay2sGatewayService } from '@/modules/order/application/services/payment/checkout/pay2s-gateway.service';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { ProductClient } from '@/modules/order/application/clients/product.client';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type {
    Pay2sEnvironment,
    Pay2sBankTransaction,
    Pay2sInvoiceMetadata,
    Pay2sIpnPayload,
    Pay2sRedirectPayload,
    Pay2sVerifiedTransaction,
} from '@/modules/order/application/types/payments/pay2s.types';
import { PAY2S_ORDER_PAYMENT_TTL_MS } from '@/modules/order/application/constants/payments/pay2s.constants';

const PAY2S_HISTORY_IPN_MATCH_WINDOW_MS = 30_000;

type PaymentReturnResponse =
    | { status: 'PAID'; orderId: string }
    | { status: 'WALLET_DEPOSIT_PAID'; depositId: string }
    | {
          status:
              | 'FAILED'
              | 'CANCELLED'
              | 'REFUND_PENDING'
              | 'REFUND_FAILED'
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
    private historyReconciliationRunning = false;
    private nextHistoryReconciliationAt = 0;

    constructor(
        private readonly dataSource: DataSource,
        private readonly config: ConfigService,
        private readonly gateway: Pay2sGatewayService,
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

    // Đối soát lịch sử ngân hàng trước khi quét hạn để IPN bị lỡ không làm đơn đã trả bị đánh dấu thất bại.
    onModuleInit(): void {
        this.expirationTimer = setInterval(
            () => void this.runPaymentMaintenance(),
            30_000,
        );
        void this.runPaymentMaintenance();
    }

    // Dừng timer khi service shutdown để không giữ process hoặc unit test mở.
    onModuleDestroy(): void {
        if (this.expirationTimer) clearInterval(this.expirationTimer);
    }

    // Tạo attempt trước khi gọi provider để timeout vẫn giữ merchant orderId và requestId của cùng một lần thử.
    // Retry chỉ trả link đã lưu; nếu kết quả tạo link chưa rõ thì chờ đối soát/hết hạn thay vì tạo QR thứ hai.
    async startPay2sPayment(
        order: Order,
        _ipAddress: string,
    ): Promise<{ paymentUrl: string; attempt: PaymentAttempt }> {
        // Khóa Order trước để mọi pod cùng tái sử dụng một attempt/link, đồng thời từ chối request đến sau khi order đã PAID.
        const claim = await this.dataSource.transaction(async (manager) => {
            const orderRepository = manager.getRepository(Order);
            const currentOrder = await orderRepository.findOne({
                where: { id: order.id },
                lock: { mode: 'pessimistic_write' },
            });
            if (
                !currentOrder ||
                currentOrder.paymentMethod !== PaymentMethod.PAY2S ||
                currentOrder.paymentStatus !== PaymentStatus.PENDING ||
                currentOrder.status !== OrderStatus.PENDING
            )
                throw new BadRequestException(
                    'Đơn hàng không còn ở trạng thái chờ thanh toán Pay2S.',
                );

            // Deadline cũ 15 phút được hạ về mốc tạo order + 10 phút; giá trị sớm hơn vẫn được giữ nguyên.
            const providerDeadline = new Date(
                currentOrder.createdAt.getTime() + PAY2S_ORDER_PAYMENT_TTL_MS,
            );
            const effectiveDeadline = currentOrder.paymentExpiresAt
                ? new Date(
                      Math.min(
                          currentOrder.paymentExpiresAt.getTime(),
                          providerDeadline.getTime(),
                      ),
                  )
                : providerDeadline;
            if (
                currentOrder.paymentExpiresAt?.getTime() !==
                effectiveDeadline.getTime()
            ) {
                currentOrder.paymentExpiresAt = effectiveDeadline;
                await orderRepository.save(currentOrder);
            }

            const repository = manager.getRepository(PaymentAttempt);
            let attempt = await repository
                .createQueryBuilder('attempt')
                .addSelect('attempt.providerResponse')
                .where('attempt.order_id = :orderId', { orderId: order.id })
                .andWhere('attempt.status = :status', { status: 'PENDING' })
                .setLock('pessimistic_write')
                .getOne();

            if (attempt) {
                // Đồng bộ attempt cũ về cùng deadline trước khi tái sử dụng link Pay2S hiện tại.
                if (attempt.expiresAt.getTime() > effectiveDeadline.getTime()) {
                    attempt.expiresAt = effectiveDeadline;
                    await repository.save(attempt);
                }

                // Không trả lại link sát hạn dù worker hủy chưa kịp chạy; khoản chuyển muộn sẽ đi vào luồng hoàn.
                if (attempt.expiresAt.getTime() <= Date.now() + 30_000)
                    throw new BadRequestException(
                        'Phiên thanh toán gần hết hạn. Hãy tải lại đơn hàng trước khi thanh toán.',
                    );

                // Trả lại đúng link đã tạo; lặp request không gọi Pay2S lần nữa và không tạo một QR khác.
                const existingPaymentUrl = this.readStoredPay2sPaymentUrl(
                    attempt.providerResponse,
                );
                if (existingPaymentUrl)
                    return { attempt, paymentUrl: existingPaymentUrl };

                // Request ID đã ghi trước network call nhưng chưa có response là kết quả chưa rõ; không phát link thứ hai.
                if (attempt.providerRequestId)
                    throw new ServiceUnavailableException(
                        'Pay2S đang xác minh lần tạo link trước. Đừng thanh toán lại; hãy làm mới trạng thái đơn sau ít phút.',
                    );
            } else {
                attempt = repository.create({
                    orderId: currentOrder.id,
                    merchantReference: this.gateway.createMerchantReference(),
                    providerRequestId: null,
                    providerOrderInfo: null,
                    providerTransactionId: null,
                    pay2sHistoryId: null,
                    pay2sBankTransactionId: null,
                    pay2sHistoryChecksum: null,
                    status: 'PENDING',
                    environment: this.getEnvironment(),
                    amount: currentOrder.totalAmount,
                    currency: 'VND',
                    expiresAt: effectiveDeadline,
                    providerCreateDate: null,
                    confirmedAt: null,
                    refundRequestId: null,
                    providerResponse: null,
                });
                attempt = await repository.save(attempt);
            }

            // Không mở link sát giờ tự hủy; cửa sổ này phải đủ thời gian để khách hoàn tất và Pay2S gửi IPN.
            if (attempt.expiresAt.getTime() <= Date.now() + 30_000)
                throw new BadRequestException(
                    'Phiên thanh toán gần hết hạn. Hãy tải lại đơn hàng trước khi thanh toán.',
                );

            // Lưu trước orderInfo duy nhất để lịch sử ngân hàng vẫn khớp được nếu Pay2S tạo link nhưng response bị mất.
            const requestOrderInfo = `Thanh toan don ${currentOrder.orderNumber}`;
            if (!attempt.providerOrderInfo) {
                attempt.providerOrderInfo = requestOrderInfo;
                await repository.update(attempt.id, {
                    providerOrderInfo: requestOrderInfo,
                });
            }

            // Lưu request ID duy nhất trước khi gọi provider; nếu timeout mơ hồ thì lần sau không tạo yêu cầu thứ hai.
            const requestId = this.gateway.createMerchantReference('REQ');
            await repository.update(attempt.id, {
                providerRequestId: requestId,
            });
            attempt.providerRequestId = requestId;
            return { attempt, requestId };
        });

        if (!('requestId' in claim)) {
            if (typeof claim.paymentUrl !== 'string')
                throw new ServiceUnavailableException(
                    'Không lấy được liên kết thanh toán Pay2S. Vui lòng làm mới trạng thái đơn hàng.',
                );
            return { paymentUrl: claim.paymentUrl, attempt: claim.attempt };
        }
        if (typeof claim.requestId !== 'string')
            throw new ServiceUnavailableException(
                'Chưa xác định được yêu cầu thanh toán Pay2S. Vui lòng tải lại đơn hàng.',
            );

        const paymentUrl = await this.createPay2sLink(
            order,
            claim.attempt,
            claim.requestId,
        );
        const currentAttempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .findOne({
                where: { id: claim.attempt.id },
                select: { id: true, status: true, expiresAt: true },
            });
        const currentOrder = await this.dataSource
            .getRepository(Order)
            .findOne({
                where: { id: order.id },
                select: {
                    id: true,
                    status: true,
                    paymentMethod: true,
                    paymentStatus: true,
                },
            });
        if (
            !currentAttempt ||
            currentAttempt.status !== 'PENDING' ||
            currentAttempt.expiresAt.getTime() <= Date.now() ||
            !currentOrder ||
            currentOrder.paymentMethod !== PaymentMethod.PAY2S ||
            currentOrder.paymentStatus !== PaymentStatus.PENDING ||
            currentOrder.status !== OrderStatus.PENDING
        ) {
            // Không trả URL của phiên đã chốt/hết hạn; hủy best-effort không thay thế xử lý khoản tiền đến muộn.
            await this.gateway
                .cancelPayment({
                    orderId: claim.attempt.merchantReference,
                    requestId: this.gateway.createMerchantReference('CANCEL'),
                    environment: claim.attempt.environment,
                })
                .catch(() => undefined);
            throw new BadRequestException(
                'Phiên thanh toán đã được chốt hoặc hết hạn. Hãy kiểm tra trạng thái đơn trước khi trả tiền.',
            );
        }

        const refreshedAttempt = await this.dataSource
            .getRepository(PaymentAttempt)
            .createQueryBuilder('attempt')
            .addSelect('attempt.providerResponse')
            .where('attempt.id = :attemptId', { attemptId: claim.attempt.id })
            .getOne();
        return {
            paymentUrl,
            attempt: refreshedAttempt ?? claim.attempt,
        };
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

    // Admin xác nhận khoản COD đã chuyển; danh tính và thời điểm xử lý được lưu bằng trường audit chuẩn.
    async recordCodRefund(input: {
        returnRequestId: string;
        adminId: string;
        amount: string;
    }): Promise<void> {
        if (!input.adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        await this.sellerWalletRepository.recordCodRefund(input);
    }

    // Gửi yêu cầu hủy tới Pay2S; Order chỉ đổi trạng thái sau khi provider xác nhận đã hủy link.
    async cancelPendingPay2sPayment(
        merchantReference: string,
        environment: Pay2sEnvironment,
    ): Promise<void> {
        const result = await this.gateway.cancelPayment({
            orderId: merchantReference,
            requestId: this.gateway.createMerchantReference('CANCEL'),
            environment,
        });
        if (
            result.resultCode !== '0' ||
            result.status.toLowerCase() !== 'cancelled'
        )
            throw new BadRequestException(
                'Pay2S chưa xác nhận hủy giao dịch. Vui lòng tải lại trạng thái đơn hàng.',
            );
    }

    // Đảo phần sale pending của order Pay2S vừa hủy; source key giúp request hủy lặp không trừ ví hai lần.
    async reverseCancelledOrder(orderId: string): Promise<void> {
        await this.sellerWalletRepository.reverseCancelledOrder(orderId);
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

    // IPN là nguồn ghi nhận bền vững: verify chữ ký và amount trước khi cập nhật lần thử thanh toán.
    // Callback thu tiền khóa order/attempt; hủy hoặc thất bại chỉ đóng attempt để order còn có thể retry.
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
            // Hủy một phiên Pay2S không phải hủy đơn; chỉ đóng attempt hiện tại để attempt mới còn dùng được.
            await this.markAttemptFailed(attempt.id, payload);
            return { success: true };
        }
        if (!payload.transId.trim()) return { success: false };

        await this.processVerifiedSuccessfulPayment(attempt, {
            providerTransactionId: payload.transId,
            historyTransactionId: null,
            bankTransactionId: null,
            historyChecksum: null,
            orderInfo: payload.orderInfo,
            amount: payload.amount,
            receivedAt: this.readPay2sResponseTime(payload.responseTime),
            providerResponse: this.redactCallback(payload),
        });
        return { success: true };
    }

    // Redirect phải qua chữ ký và khớp merchant reference, amount với attempt đã lưu.
    // Chỉ IPN/lịch sử đối soát được báo PAID; redirect thất bại chỉ đóng attempt để lần retry tạo link mới.
    // Khi kết quả đã được chốt ở database, trạng thái đó ưu tiên hơn mã redirect đến muộn.
    // transId tùy chọn nhưng nếu có thì phải khớp bằng chứng đã lưu; mismatch trả UNVERIFIED.
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
            if (deposit.status === 'PAID') {
                // IPN là nguồn PAID; transId trên Return có thể vắng mặt, nhưng nếu có thì phải khớp tuyệt đối.
                if (
                    payload.transId &&
                    deposit.providerTransactionId !== payload.transId
                )
                    return { status: 'UNVERIFIED' };
                return { status: 'WALLET_DEPOSIT_PAID', depositId: deposit.id };
            }
            if (deposit.status === 'FAILED')
                return { status: 'WALLET_DEPOSIT_FAILED' };
            return { status: 'PENDING' };
        }
        if (!this.isAmountEqual(payload.amount, attempt.amount))
            return { status: 'UNVERIFIED' };
        if (attempt.status === 'PAID') {
            // Nếu history chốt trước IPN, Return đã ký chỉ được ghép theo nội dung và thời điểm cùng khoản thu.
            const historyConfirmedPayment =
                !attempt.providerTransactionId &&
                Boolean(attempt.pay2sHistoryId) &&
                Boolean(attempt.confirmedAt) &&
                this.normalizePay2sOrderInfo(payload.orderInfo) ===
                    this.normalizePay2sOrderInfo(
                        attempt.providerOrderInfo ?? '',
                    ) &&
                this.isPay2sTimestampNear(
                    attempt.confirmedAt,
                    this.readPay2sResponseTime(payload.responseTime),
                );
            if (
                payload.transId &&
                attempt.providerTransactionId !== payload.transId &&
                !historyConfirmedPayment
            ) {
                const recordedDuplicate = await this.dataSource
                    .getRepository(PaymentAttempt)
                    .findOne({
                        where: {
                            orderId: attempt.orderId,
                            providerTransactionId: payload.transId,
                        },
                    });
                if (!recordedDuplicate) return { status: 'UNVERIFIED' };
            }
            return { status: 'PAID', orderId: attempt.orderId };
        }
        if (attempt.status === 'REFUND_PENDING')
            return { status: 'REFUND_PENDING' };
        if (attempt.status === 'REFUND_FAILED')
            return { status: 'REFUND_FAILED' };
        if (attempt.status === 'REFUNDED') return { status: 'REFUNDED' };

        // Redirect Pay2S đã ký xác nhận lần thử thất bại/hủy; đóng attempt cũ nhưng giữ order để khách thanh toán lại.
        if (String(payload.resultCode) !== '0') {
            const currentAttemptStatus = await this.markAttemptFailed(
                attempt.id,
                payload,
            );

            // IPN thành công có thể thắng cuộc đua với redirect; tuyệt đối không báo hủy nếu database đã ghi nhận tiền.
            if (currentAttemptStatus === 'PAID')
                return { status: 'PAID', orderId: attempt.orderId };
            if (currentAttemptStatus === 'REFUND_PENDING')
                return { status: 'REFUND_PENDING' };
            if (currentAttemptStatus === 'REFUND_FAILED')
                return { status: 'REFUND_FAILED' };
            if (currentAttemptStatus === 'REFUNDED')
                return { status: 'REFUNDED' };

            return String(payload.resultCode) === '2'
                ? { status: 'CANCELLED' }
                : { status: 'FAILED' };
        }

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

    // Chạy lịch sử Pay2S trước bộ hết hạn; lỗi provider chỉ được log và không ngăn order chuyển khỏi PENDING đúng hạn.
    private async runPaymentMaintenance(): Promise<void> {
        await this.reconcilePay2sTransactionHistory();
        await this.expirePendingOrders().catch((error: unknown) =>
            this.logger.error(
                'Không quét được order Pay2S hết hạn.',
                error instanceof Error ? error.stack : undefined,
            ),
        );
    }

    // Đối soát mỗi phút ở LIVE; history ID chống quét lặp riêng, IPN được ghép theo thời điểm.
    private async reconcilePay2sTransactionHistory(): Promise<void> {
        const nowMs = Date.now();
        if (
            this.config.get<string>('PAY2S_MODE', 'disabled') !== 'live' ||
            this.historyReconciliationRunning ||
            nowMs < this.nextHistoryReconciliationAt
        )
            return;

        this.historyReconciliationRunning = true;
        this.nextHistoryReconciliationAt = nowMs + 60_000;
        try {
            const now = new Date(nowMs);
            const begin = this.formatPay2sHistoryDate(
                new Date(nowMs - 24 * 60 * 60_000),
            );
            const end = this.formatPay2sHistoryDate(now);
            const transactions = await this.gateway.getTransactionHistory(
                begin,
                end,
            );
            if (transactions.length === 0) return;

            // Giới hạn số order gần đây để một batch không giữ database connection trong lúc provider chậm.
            const attempts = await this.dataSource
                .getRepository(PaymentAttempt)
                .createQueryBuilder('attempt')
                .addSelect('attempt.providerResponse')
                .where('attempt.environment = :environment', {
                    environment: 'LIVE',
                })
                .andWhere('attempt.status IN (:...statuses)', {
                    statuses: [
                        'PENDING',
                        'FAILED',
                        'EXPIRED',
                        'PAID',
                        'REFUND_PENDING',
                        'REFUND_FAILED',
                        'REFUNDED',
                    ],
                })
                .andWhere('attempt.created_at >= :createdAfter', {
                    createdAfter: new Date(nowMs - 48 * 60 * 60_000),
                })
                .orderBy('attempt.created_at', 'ASC')
                .take(500)
                .getMany();
            if (attempts.length === 0) return;

            const correlatedHistoryAttempts =
                this.findHistoryMatchesForProviderTransactions(
                    attempts,
                    transactions,
                );
            for (const transaction of transactions) {
                if (transaction.type !== 'IN') continue;
                const receivedAt = this.parsePay2sHistoryDate(
                    transaction.transactionDate,
                );
                if (!receivedAt) {
                    this.logger.warn(
                        `Bỏ qua giao dịch lịch sử Pay2S sai ngày giờ. bankTransactionId=${transaction.bankTransactionId}`,
                    );
                    continue;
                }
                const correlatedAttemptId = correlatedHistoryAttempts.get(
                    transaction.historyTransactionId,
                );
                const attempt = correlatedAttemptId
                    ? (attempts.find(
                          (candidate) => candidate.id === correlatedAttemptId,
                      ) ?? null)
                    : this.findHistoryPaymentAttempt(
                          attempts,
                          transaction,
                          receivedAt,
                      );
                if (!attempt) continue;

                // Lịch sử lưu ID riêng; chỉ một row gần nhất được gắn vào IPN đã ghi nhận.
                await this.processVerifiedSuccessfulPayment(attempt, {
                    providerTransactionId: null,
                    historyTransactionId: transaction.historyTransactionId,
                    bankTransactionId: transaction.bankTransactionId,
                    historyChecksum: transaction.checksum,
                    historyMatchesAttempt: correlatedAttemptId === attempt.id,
                    orderInfo: transaction.description,
                    amount: transaction.amount,
                    receivedAt,
                    providerResponse: {
                        source: 'PAY2S_TRANSACTION_HISTORY',
                        bankTransactionId: transaction.bankTransactionId,
                        historyChecksum: transaction.checksum,
                        transactionDate: transaction.transactionDate,
                        accountNumber: transaction.accountNumber,
                        amount: transaction.amount,
                        bank: transaction.bank,
                        description: transaction.description,
                    },
                });
            }
        } catch (error: unknown) {
            this.logger.warn(
                `Đối soát lịch sử Pay2S thất bại: ${error instanceof Error ? error.message : 'unknown'}`,
            );
        } finally {
            this.historyReconciliationRunning = false;
        }
    }

    // Ghép lịch sử với IPN chỉ khi đơn, số tiền và thời điểm cùng khớp; mỗi giao dịch chỉ ghép một lần.
    private findHistoryMatchesForProviderTransactions(
        attempts: PaymentAttempt[],
        transactions: Pay2sBankTransaction[],
    ): Map<string, string> {
        const possibleMatches = transactions.flatMap((transaction) => {
            if (transaction.type !== 'IN') return [];
            const receivedAt = this.parsePay2sHistoryDate(
                transaction.transactionDate,
            );
            const normalizedDescription = this.normalizePay2sOrderInfo(
                transaction.description,
            );
            if (!receivedAt || !normalizedDescription) return [];

            const providerMatches = attempts.flatMap((attempt) => {
                const normalizedOrderInfo = this.normalizePay2sOrderInfo(
                    attempt.providerOrderInfo ?? '',
                );
                const source = attempt.providerResponse?.source;
                if (
                    !attempt.providerTransactionId ||
                    attempt.pay2sHistoryId ||
                    source === 'PAY2S_TRANSACTION_HISTORY' ||
                    !attempt.confirmedAt ||
                    ![
                        'PAID',
                        'REFUND_PENDING',
                        'REFUND_FAILED',
                        'REFUNDED',
                    ].includes(attempt.status) ||
                    !normalizedOrderInfo ||
                    !normalizedDescription.includes(normalizedOrderInfo) ||
                    !this.isAmountEqual(transaction.amount, attempt.amount)
                )
                    return [];

                const deltaMs = Math.abs(
                    attempt.confirmedAt.getTime() - receivedAt.getTime(),
                );
                if (deltaMs > PAY2S_HISTORY_IPN_MATCH_WINDOW_MS) return [];
                return [
                    {
                        historyId: transaction.historyTransactionId,
                        attemptId: attempt.id,
                        deltaMs,
                        priority: 0,
                    },
                ];
            });

            // Dự phòng một attempt chưa chốt để IPN đến giữa lúc đọc và khóa vẫn được ghép an toàn.
            const fallbackAttempt = this.findHistoryPaymentAttempt(
                attempts,
                transaction,
                receivedAt,
            );
            if (
                !fallbackAttempt ||
                fallbackAttempt.providerTransactionId ||
                fallbackAttempt.pay2sHistoryId ||
                !['PENDING', 'FAILED', 'EXPIRED'].includes(
                    fallbackAttempt.status,
                )
            )
                return providerMatches;

            return [
                ...providerMatches,
                {
                    historyId: transaction.historyTransactionId,
                    attemptId: fallbackAttempt.id,
                    deltaMs: Math.max(
                        0,
                        receivedAt.getTime() -
                            fallbackAttempt.createdAt.getTime(),
                    ),
                    priority: 1,
                },
            ];
        });

        // Ghép IPN trước, rồi ghép attempt đang mở; không tái sử dụng cùng attempt hoặc ID lịch sử.
        possibleMatches.sort(
            (left, right) =>
                left.priority - right.priority || left.deltaMs - right.deltaMs,
        );
        const matches = new Map<string, string>();
        const usedAttempts = new Set<string>();
        for (const match of possibleMatches) {
            if (
                matches.has(match.historyId) ||
                usedAttempts.has(match.attemptId)
            )
                continue;
            matches.set(match.historyId, match.attemptId);
            usedAttempts.add(match.attemptId);
        }
        return matches;
    }

    // Hai nguồn Pay2S chỉ được coi là cùng khoản thu khi timestamp nằm trong cửa sổ hẹp đã đối chiếu production.
    private isPay2sTimestampNear(left: Date | null, right: Date): boolean {
        return (
            left instanceof Date &&
            !Number.isNaN(left.getTime()) &&
            Math.abs(left.getTime() - right.getTime()) <=
                PAY2S_HISTORY_IPN_MATCH_WINDOW_MS
        );
    }

    // Chọn theo cửa sổ thời gian của attempt để giao dịch cũ không bị gán sang lần thử mới đang PENDING.
    private findHistoryPaymentAttempt(
        attempts: PaymentAttempt[],
        transaction: Pay2sBankTransaction,
        receivedAt: Date,
    ): PaymentAttempt | null {
        const normalizedDescription = this.normalizePay2sOrderInfo(
            transaction.description,
        );
        const matches = attempts.filter((attempt) => {
            const orderInfo = attempt.providerOrderInfo;
            // Row lịch sử giả do phiên bản cũ tạo không thể làm nguồn đối soát lần nữa.
            const isLegacyHistoryRefund =
                attempt.providerResponse?.source ===
                    'PAY2S_TRANSACTION_HISTORY' && !attempt.pay2sHistoryId;
            if (
                isLegacyHistoryRefund ||
                !orderInfo ||
                !this.isAmountEqual(transaction.amount, attempt.amount)
            )
                return false;
            const normalizedOrderInfo = this.normalizePay2sOrderInfo(orderInfo);
            return (
                normalizedOrderInfo.length >= 8 &&
                normalizedDescription.includes(normalizedOrderInfo)
            );
        });

        // Ưu tiên attempt có hiệu lực tại thời điểm chuyển; trong khoảng chồng lấn, attempt PENDING mới nhất là đích hiện tại.
        const attemptsInPaymentWindow = matches.filter(
            (attempt) =>
                attempt.createdAt instanceof Date &&
                attempt.expiresAt instanceof Date &&
                receivedAt >= attempt.createdAt &&
                receivedAt <= attempt.expiresAt,
        );
        const pendingInWindow = attemptsInPaymentWindow
            .filter((attempt) => attempt.status === 'PENDING')
            .sort(
                (left, right) =>
                    right.createdAt.getTime() - left.createdAt.getTime(),
            )[0];
        if (pendingInWindow) return pendingInWindow;

        const paidInWindow = attemptsInPaymentWindow.find((attempt) =>
            ['PAID', 'REFUND_PENDING', 'REFUND_FAILED', 'REFUNDED'].includes(
                attempt.status,
            ),
        );
        if (paidInWindow) return paidInWindow;

        const closedInWindow = attemptsInPaymentWindow
            .filter((attempt) => ['FAILED', 'EXPIRED'].includes(attempt.status))
            .sort(
                (left, right) =>
                    right.createdAt.getTime() - left.createdAt.getTime(),
            )[0];
        if (closedInWindow) return closedInWindow;

        // Giao dịch sau hạn gắn với lần thử gần nhất đã bắt đầu; giao dịch trước mọi lần thử không được tự nhận vơ.
        const latestStartedAttempt = matches
            .filter(
                (attempt) =>
                    attempt.createdAt instanceof Date &&
                    receivedAt >= attempt.createdAt,
            )
            .sort(
                (left, right) =>
                    right.createdAt.getTime() - left.createdAt.getTime(),
            )[0];
        return latestStartedAttempt ?? null;
    }

    // Chuẩn hóa khoảng trắng và dấu câu để nội dung chuyển khoản vẫn khớp chính xác mã Pay2S duy nhất.
    private normalizePay2sOrderInfo(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    // API lịch sử trả giờ Việt Nam không kèm offset; gắn +07:00 để so hạn thanh toán không lệch theo timezone container.
    private parsePay2sHistoryDate(value: string): Date | null {
        const match = value.match(
            /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
        );
        if (!match) return null;
        const parsed = new Date(
            `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+07:00`,
        );
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    // Tạo ngày dd/mm/yyyy theo timezone ngân hàng mà API Pay2S yêu cầu.
    private formatPay2sHistoryDate(value: Date): string {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        }).format(value);
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
        const deadlineSql = `LEAST(
            COALESCE(
                order.payment_expires_at,
                order.created_at + (:ttlMs * INTERVAL '1 millisecond')
            ),
            order.created_at + (:ttlMs * INTERVAL '1 millisecond')
        )`;
        const candidates = await this.dataSource
            .getRepository(Order)
            .createQueryBuilder('order')
            .select('order.id', 'id')
            .where('order.payment_method = :paymentMethod', {
                paymentMethod: PaymentMethod.PAY2S,
            })
            .andWhere('order.status = :status', {
                status: OrderStatus.PENDING,
            })
            .andWhere(`${deadlineSql} <= :now`, {
                now,
                ttlMs: PAY2S_ORDER_PAYMENT_TTL_MS,
            })
            .orderBy(deadlineSql, 'ASC')
            .take(50)
            .getRawMany<{ id: string }>();
        for (const candidate of candidates) {
            const expired = await this.dataSource.transaction(
                async (manager) => {
                    const orderRepository = manager.getRepository(Order);
                    const order = await orderRepository.findOne({
                        where: { id: candidate.id },
                        lock: { mode: 'pessimistic_write' },
                    });
                    if (!order || order.status !== OrderStatus.PENDING)
                        return null;
                    const effectiveDeadline = Math.min(
                        order.paymentExpiresAt?.getTime() ??
                            Number.POSITIVE_INFINITY,
                        order.createdAt.getTime() + PAY2S_ORDER_PAYMENT_TTL_MS,
                    );
                    if (effectiveDeadline > now.getTime()) return null;
                    // Cập nhật timestamp cũ để API/UI và worker giữ cùng mốc hết hạn sau lần xử lý đầu tiên.
                    order.paymentExpiresAt = new Date(effectiveDeadline);
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
                        reason: 'Hết hạn thanh toán Pay2S sau 10 phút.',
                    });
                    if (attempt) {
                        attempt.expiresAt = order.paymentExpiresAt;
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

    // Chỉ IPN thành công mới ghi nhận side effects tài chính và event; Cart được xử lý riêng bởi durable outbox.
    // Callback không gọi Cart trực tiếp để timeout dependency không làm mất khả năng retry cleanup.
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
        requestId: string,
    ): Promise<string> {
        const result = await this.gateway.createPayment({
            orderId: attempt.merchantReference,
            requestId,
            amount: attempt.amount,
            orderInfo: `Thanh toan don ${order.orderNumber}`,
            redirectUrl: this.config.get<string>('PAY2S_RETURN_URL', ''),
            ipnUrl: this.config.get<string>('PAY2S_IPN_URL', ''),
            metadata: this.createOrderMetadata(order),
            environment: attempt.environment,
        });
        // Chỉ cập nhật cột response, tránh save entity cũ ghi đè PAID nếu IPN đến trong lúc provider trả link.
        // Ghép JSONB để giữ callback/IPN đã lưu trước đó, đồng thời thêm URL và QR từ phản hồi tạo link.
        await this.dataSource
            .getRepository(PaymentAttempt)
            .createQueryBuilder()
            .update(PaymentAttempt)
            .set({
                providerOrderInfo: result.orderInfo,
                providerResponse: () =>
                    `COALESCE("provider_response", '{}'::jsonb) || CAST(:providerResponse AS jsonb)`,
            })
            .where('id = :attemptId', { attemptId: attempt.id })
            .setParameter('providerResponse', JSON.stringify(result.response))
            .execute();
        return result.payUrl;
    }

    // Chỉ tái sử dụng URL HTTPS do Pay2S trả về; response thiếu hoặc sai host sẽ không được mở cho khách.
    private readStoredPay2sPaymentUrl(
        providerResponse: Record<string, unknown> | null,
    ): string | null {
        const candidate = providerResponse?.payUrl;
        if (typeof candidate !== 'string') return null;
        try {
            const url = new URL(candidate);
            return url.protocol === 'https:' &&
                (url.hostname === 'pay2s.vn' ||
                    url.hostname.endsWith('.pay2s.vn'))
                ? candidate
                : null;
        } catch {
            return null;
        }
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

    // Chỉ chuyển attempt PENDING sang FAILED; trả trạng thái dưới khóa để Return không che kết quả IPN đến đồng thời.
    private async markAttemptFailed(
        attemptId: string,
        payload: Pay2sIpnPayload | Pay2sRedirectPayload,
    ): Promise<PaymentAttempt['status'] | null> {
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(PaymentAttempt);
            const attempt = await repository.findOne({
                where: { id: attemptId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!attempt) return null;

            // Chỉ callback đầu tiên mới chốt PENDING; callback muộn giữ nguyên PAID/refund đã ghi trước đó.
            if (attempt.status === 'PENDING') {
                attempt.status = 'FAILED';
                attempt.providerOrderInfo = payload.orderInfo;
                attempt.providerResponse = this.redactCallback(payload);
                await repository.save(attempt);
            }

            return attempt.status;
        });
    }

    // Khóa order/attempt để IPN, lịch sử và thao tác hủy không ghi đè nhau.
    // ID Pay2S chuẩn ngăn xử lý lặp; khoản thu riêng/đến muộn mới vào hàng hoàn.
    private async processVerifiedSuccessfulPayment(
        attempt: PaymentAttempt,
        transaction: Pay2sVerifiedTransaction,
    ): Promise<void> {
        const outcome = await this.dataSource.transaction(async (manager) => {
            // Mọi nhánh thu tiền đều khóa order trước attempt để tránh deadlock với hủy và worker hết hạn.
            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository.findOne({
                where: { id: attempt.orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!order)
                throw new NotFoundException('Không tìm thấy đơn hàng Pay2S.');

            const attemptRepository = manager.getRepository(PaymentAttempt);
            // providerResponse mặc định select:false; lấy kèm lúc khóa để nối IPN/lịch sử không làm mất audit payload.
            const lockedAttempt = await attemptRepository
                .createQueryBuilder('attempt')
                .addSelect('attempt.providerResponse')
                .where('attempt.id = :attemptId', { attemptId: attempt.id })
                .setLock('pessimistic_write')
                .getOne();
            if (!lockedAttempt)
                throw new NotFoundException('Không tìm thấy giao dịch Pay2S.');

            // History ID chống quét lặp độc lập; không hỏi database bằng provider ID null vì sẽ trùng mọi row null.
            const existingHistory = transaction.historyTransactionId
                ? await attemptRepository.findOne({
                      where: {
                          pay2sHistoryId: transaction.historyTransactionId,
                      },
                  })
                : null;
            if (existingHistory)
                return existingHistory.orderId === order.id
                    ? 'duplicate'
                    : 'duplicate-transaction-conflict';

            // Chỉ IPN transId là provider ID; mã ngân hàng và history ID có khóa riêng.
            const existingTransaction = transaction.providerTransactionId
                ? await attemptRepository.findOne({
                      where: {
                          providerTransactionId:
                              transaction.providerTransactionId,
                      },
                  })
                : null;
            if (existingTransaction)
                return existingTransaction.orderId === order.id
                    ? 'duplicate'
                    : 'duplicate-transaction-conflict';

            // Lịch sử có thể đến sau IPN; ghép row vào attempt đã PAID thay vì sinh một khoản hoàn giả.
            const normalizedStoredOrderInfo = this.normalizePay2sOrderInfo(
                lockedAttempt.providerOrderInfo ?? '',
            );
            const normalizedIncomingOrderInfo = this.normalizePay2sOrderInfo(
                transaction.orderInfo,
            );
            const historyConfirmsProviderPayment =
                transaction.historyMatchesAttempt === true &&
                Boolean(lockedAttempt.providerTransactionId) &&
                Boolean(transaction.historyTransactionId) &&
                Boolean(transaction.bankTransactionId) &&
                normalizedStoredOrderInfo.length >= 8 &&
                normalizedIncomingOrderInfo.includes(
                    normalizedStoredOrderInfo,
                ) &&
                this.isAmountEqual(transaction.amount, lockedAttempt.amount) &&
                this.isPay2sTimestampNear(
                    lockedAttempt.confirmedAt,
                    transaction.receivedAt,
                );
            if (historyConfirmsProviderPayment) {
                lockedAttempt.pay2sHistoryId = transaction.historyTransactionId;
                lockedAttempt.pay2sBankTransactionId =
                    transaction.bankTransactionId;
                lockedAttempt.pay2sHistoryChecksum =
                    transaction.historyChecksum;
                lockedAttempt.providerResponse = {
                    ...(lockedAttempt.providerResponse ?? {}),
                    pay2sHistory: {
                        historyTransactionId: transaction.historyTransactionId,
                        bankTransactionId: transaction.bankTransactionId,
                        checksum: transaction.historyChecksum,
                        receivedAt: transaction.receivedAt.toISOString(),
                    },
                };
                await attemptRepository.save(lockedAttempt);
                return 'history-linked';
            }

            // Nếu history chạy trước IPN, gắn transId thật vào đúng history attempt theo số tiền/nội dung/thời điểm.
            const ipnConfirmsHistoryPayment =
                Boolean(transaction.providerTransactionId) &&
                !transaction.historyTransactionId &&
                !lockedAttempt.providerTransactionId &&
                Boolean(lockedAttempt.pay2sHistoryId) &&
                [
                    'PAID',
                    'REFUND_PENDING',
                    'REFUND_FAILED',
                    'REFUNDED',
                ].includes(lockedAttempt.status) &&
                this.isAmountEqual(transaction.amount, lockedAttempt.amount) &&
                normalizedStoredOrderInfo.length >= 8 &&
                normalizedIncomingOrderInfo.length >= 8 &&
                (normalizedStoredOrderInfo.includes(
                    normalizedIncomingOrderInfo,
                ) ||
                    normalizedIncomingOrderInfo.includes(
                        normalizedStoredOrderInfo,
                    )) &&
                this.isPay2sTimestampNear(
                    lockedAttempt.confirmedAt,
                    transaction.receivedAt,
                );
            if (ipnConfirmsHistoryPayment) {
                lockedAttempt.providerTransactionId =
                    transaction.providerTransactionId;
                lockedAttempt.providerResponse = {
                    ...(lockedAttempt.providerResponse ?? {}),
                    ipnConfirmation: transaction.providerResponse,
                };
                await attemptRepository.save(lockedAttempt);
                return 'history-linked';
            }

            if (
                [
                    'PAID',
                    'REFUND_PENDING',
                    'REFUND_FAILED',
                    'REFUNDED',
                ].includes(lockedAttempt.status)
            )
                return this.recordDuplicatePayment(
                    attemptRepository,
                    lockedAttempt,
                    transaction,
                );

            const anotherAttemptPaid = await attemptRepository
                .createQueryBuilder('attempt')
                .where('attempt.order_id = :orderId', { orderId: order.id })
                .andWhere('attempt.status = :status', { status: 'PAID' })
                .andWhere('attempt.id <> :attemptId', {
                    attemptId: lockedAttempt.id,
                })
                .getExists();
            const orderIsOpen =
                order.status === OrderStatus.PENDING &&
                order.paymentStatus === PaymentStatus.PENDING;
            const paidAfterAttemptCreated =
                transaction.receivedAt >= lockedAttempt.createdAt;
            const paidBeforeExpiry =
                transaction.receivedAt <= lockedAttempt.expiresAt;
            const canRecoverFailedAttempt =
                transaction.providerResponse.source ===
                    'PAY2S_TRANSACTION_HISTORY' &&
                lockedAttempt.status === 'FAILED' &&
                orderIsOpen &&
                paidAfterAttemptCreated &&
                paidBeforeExpiry;
            const canConfirmOrder =
                orderIsOpen &&
                paidAfterAttemptCreated &&
                paidBeforeExpiry &&
                (lockedAttempt.status === 'PENDING' || canRecoverFailedAttempt);

            lockedAttempt.providerTransactionId =
                transaction.providerTransactionId;
            lockedAttempt.pay2sHistoryId = transaction.historyTransactionId;
            lockedAttempt.pay2sBankTransactionId =
                transaction.bankTransactionId;
            lockedAttempt.pay2sHistoryChecksum = transaction.historyChecksum;
            // Giữ nội dung trong giới hạn cột; payload đầy đủ vẫn được lưu để admin tra soát.
            lockedAttempt.providerOrderInfo =
                lockedAttempt.providerOrderInfo ??
                transaction.orderInfo.slice(0, 180);
            lockedAttempt.providerResponse = {
                ...transaction.providerResponse,
                ...(anotherAttemptPaid
                    ? { refundReason: 'DUPLICATE_PAYMENT' }
                    : {}),
            };
            lockedAttempt.confirmedAt = transaction.receivedAt;
            if (!canConfirmOrder || anotherAttemptPaid) {
                // Không hồi sinh order đã đóng; nếu đây là khoản thu duy nhất nhưng đến quá hạn thì cần hoàn thủ công.
                lockedAttempt.status = 'REFUND_PENDING';
                if (
                    !anotherAttemptPaid &&
                    order.paymentStatus !== PaymentStatus.PAID
                ) {
                    const previousStatus = order.status;
                    order.paymentStatus = PaymentStatus.REFUND_PENDING;
                    if (order.status !== OrderStatus.CANCELLED) {
                        order.status = OrderStatus.CANCELLED;
                        order.fulfillmentStatus =
                            'CANCELLED' as Order['fulfillmentStatus'];
                        await manager.getRepository(OrderStatusHistory).save({
                            orderId: order.id,
                            fromStatus: previousStatus,
                            toStatus: OrderStatus.CANCELLED,
                            reason: 'Pay2S xác nhận tiền sau khi đơn đã hết hạn; cần hoàn tiền.',
                        });
                    }
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
                reason:
                    transaction.providerResponse.source ===
                    'PAY2S_TRANSACTION_HISTORY'
                        ? 'Pay2S xác nhận thanh toán qua lịch sử giao dịch.'
                        : 'Pay2S xác nhận thanh toán qua IPN đã ký.',
            });
            await this.orderEvents.enqueueCreatedForOrder(order.id, manager);
            return 'paid';
        });

        if (outcome === 'paid') await this.runPaidSideEffects(attempt.orderId);
        if (outcome === 'duplicate-payment')
            this.logger.error(
                `Pay2S ghi nhận khoản thanh toán trùng; đã tạo hồ sơ hoàn. orderId=${attempt.orderId}`,
            );
        if (outcome === 'duplicate-transaction-conflict')
            this.logger.error(
                `Pay2S gửi lại transaction ID đã gắn đơn khác. attemptId=${attempt.id}`,
            );
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
                `Pay2S đến muộn; cần hoàn tiền ngoài hệ thống. id=${attempt.id}`,
            );
        }
    }

    // Pay2S responseTime là Unix timestamp; fallback nhận lúc này khi provider không gửi field hợp lệ.
    private readPay2sResponseTime(value: string | number): Date {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return new Date();
        const milliseconds =
            numeric < 10_000_000_000 ? numeric * 1000 : numeric;
        const receivedAt = new Date(milliseconds);
        return Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt;
    }

    // Lưu khoản Pay2S thứ hai; khóa bằng IPN ID hoặc history ID tùy nguồn để callback/cron lặp không nhân hồ sơ.
    private async recordDuplicatePayment(
        repository: Repository<PaymentAttempt>,
        originalAttempt: PaymentAttempt,
        transaction: Pay2sVerifiedTransaction,
    ): Promise<
        'duplicate' | 'duplicate-payment' | 'duplicate-transaction-conflict'
    > {
        const existingHistory = transaction.historyTransactionId
            ? await repository.findOne({
                  where: { pay2sHistoryId: transaction.historyTransactionId },
              })
            : null;
        if (existingHistory)
            return existingHistory.orderId === originalAttempt.orderId
                ? 'duplicate'
                : 'duplicate-transaction-conflict';

        const existingTransaction = transaction.providerTransactionId
            ? await repository.findOne({
                  where: {
                      providerTransactionId: transaction.providerTransactionId,
                  },
              })
            : null;
        if (existingTransaction)
            return existingTransaction.orderId === originalAttempt.orderId
                ? 'duplicate'
                : 'duplicate-transaction-conflict';

        const duplicateAttempt = repository.create({
            orderId: originalAttempt.orderId,
            merchantReference: this.gateway.createMerchantReference('DUP'),
            providerRequestId: null,
            // Giới hạn field tìm kiếm trong schema; providerResponse vẫn giữ description đầy đủ.
            providerOrderInfo: transaction.orderInfo.slice(0, 180),
            providerTransactionId: transaction.providerTransactionId,
            pay2sHistoryId: transaction.historyTransactionId,
            pay2sBankTransactionId: transaction.bankTransactionId,
            pay2sHistoryChecksum: transaction.historyChecksum,
            refundRequestId: null,
            status: 'REFUND_PENDING',
            environment: originalAttempt.environment,
            amount: originalAttempt.amount,
            currency: originalAttempt.currency,
            expiresAt: originalAttempt.expiresAt,
            providerCreateDate: null,
            confirmedAt: transaction.receivedAt,
            providerResponse: {
                ...transaction.providerResponse,
                refundReason: 'DUPLICATE_PAYMENT',
            },
        });

        try {
            await repository.save(duplicateAttempt);
            return 'duplicate-payment';
        } catch (error) {
            // Callback lặp đồng thời có thể thua unique transaction ID; đọc lại để ACK đúng lần đã commit.
            if ((error as { code?: string }).code !== '23505') throw error;
            const concurrentTransaction = transaction.historyTransactionId
                ? await repository.findOne({
                      where: {
                          pay2sHistoryId: transaction.historyTransactionId,
                      },
                  })
                : transaction.providerTransactionId
                  ? await repository.findOne({
                        where: {
                            providerTransactionId:
                                transaction.providerTransactionId,
                        },
                    })
                  : null;
            if (!concurrentTransaction) throw error;
            return concurrentTransaction.orderId === originalAttempt.orderId
                ? 'duplicate'
                : 'duplicate-transaction-conflict';
        }
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
    private redactCallback(
        payload: Pay2sIpnPayload | Pay2sRedirectPayload,
    ): Record<string, unknown> {
        const { m2signature: _signature, ...redacted } = payload;
        return redacted;
    }
}
