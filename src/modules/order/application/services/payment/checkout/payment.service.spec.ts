// Unit tests cho Pay2S checkout, Return, IPN và đối soát lịch sử; giữ contract trạng thái tài chính nhất quán.
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import { Order } from '@/database/order/entities/order.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';

describe('PaymentService.startPay2sPayment', () => {
    // Chuẩn bị Order và attempt đã có link để xác nhận retry không gọi Pay2S tạo QR mới.
    it('reuses the persisted Pay2S link for the same pending attempt', async () => {
        const createdAt = new Date(Date.now() - 60_000);
        const order = {
            id: 'order-1',
            status: 'PENDING',
            paymentMethod: 'PAY2S',
            paymentStatus: 'PENDING',
            createdAt,
            paymentExpiresAt: new Date(createdAt.getTime() + 10 * 60_000),
        };
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            status: 'PENDING',
            providerRequestId: 'REQ-1',
            providerResponse: { payUrl: 'https://pay2s.vn/payment/one' },
            expiresAt: new Date(Date.now() + 5 * 60_000),
        };
        const attemptQuery = {
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            setLock: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(attempt),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
        };
        const attemptRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(attemptQuery),
        };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order ? orderRepository : attemptRepository,
            ),
        };
        const createPayment = jest.fn();
        const target = Object.assign(Object.create(PaymentService.prototype), {
            dataSource: {
                transaction: jest.fn((callback) => callback(manager)),
            },
            gateway: { createPayment },
        }) as PaymentService;

        const result = await target.startPay2sPayment(
            order as never,
            '127.0.0.1',
        );

        expect(result.paymentUrl).toBe('https://pay2s.vn/payment/one');
        expect(createPayment).not.toHaveBeenCalled();
    });
});

describe('PaymentService.processPay2sReturn', () => {
    function createTarget(
        attempt: Record<string, unknown> | null,
        verified = true,
    ): PaymentService {
        const repository = {
            findOne: jest.fn().mockResolvedValue(attempt),
        };
        return Object.assign(Object.create(PaymentService.prototype), {
            gateway: { verifyRedirect: jest.fn().mockReturnValue(verified) },
            dataSource: {
                getRepository: jest.fn().mockReturnValue(repository),
            },
            sellerWalletRepository: {
                getWalletDepositByReference: jest.fn().mockResolvedValue(null),
            },
        }) as PaymentService;
    }

    // Return không đủ field hoặc sai chữ ký không được suy diễn thành thanh toán thành công.
    it('should return UNVERIFIED for an invalid redirect', async () => {
        // Arrange
        const target = createTarget(null, false);

        // Act
        const result = await target.processPay2sReturn({});

        // Assert
        expect(result).toEqual({ status: 'UNVERIFIED' });
    });

    // Redirect hợp lệ nhưng IPN chưa ghi database chỉ hiển thị pending để tránh false positive.
    it('should return PENDING until the signed IPN is persisted', async () => {
        // Arrange
        const target = createTarget({
            merchantReference: 'ORDER_1',
            amount: '120000.00',
            status: 'PENDING',
            providerTransactionId: null,
        });
        const query = {
            accessKey: 'access',
            amount: '120000',
            message: 'pending',
            orderId: 'ORDER_1',
            orderInfo: 'P2S1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: '1',
            responseTime: '1700000000',
            resultCode: '0',
            transId: 'TRANS_1',
            m2signature: 'signature',
        };

        // Act
        const result = await target.processPay2sReturn(query);

        // Assert
        expect(result).toEqual({ status: 'PENDING' });
    });

    // Chỉ transaction ID đã lưu từ IPN mới cho phép hiển thị PAID và mở đúng order.
    it('should return PAID when the persisted transaction matches redirect', async () => {
        // Arrange
        const target = createTarget({
            merchantReference: 'ORDER_1',
            orderId: 'order-internal',
            amount: '120000.00',
            status: 'PAID',
            providerTransactionId: 'TRANS_1',
        });
        const query = {
            accessKey: 'access',
            amount: '120000',
            message: 'success',
            orderId: 'ORDER_1',
            orderInfo: 'P2S1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: '1',
            responseTime: '1700000000',
            resultCode: '0',
            transId: 'TRANS_1',
            m2signature: 'signature',
        };

        // Act
        const result = await target.processPay2sReturn(query);

        // Assert
        expect(result).toEqual({ status: 'PAID', orderId: 'order-internal' });
    });

    // Refund thất bại không được trả như giao dịch pending để khách không hiểu nhầm trạng thái tiền đã nhận.
    it('should return REFUND_FAILED when the received payment could not be refunded', async () => {
        const target = createTarget({
            merchantReference: 'ORDER_1',
            amount: '120000.00',
            status: 'REFUND_FAILED',
            providerTransactionId: 'TRANS_1',
        });

        await expect(
            target.processPay2sReturn({
                accessKey: 'access',
                amount: '120000',
                message: 'success',
                orderId: 'ORDER_1',
                orderInfo: 'P2S1',
                orderType: 'pay2s',
                partnerCode: 'partner',
                payType: 'pay2s',
                requestId: '1',
                responseTime: '1700000000',
                resultCode: '0',
                transId: 'TRANS_1',
                m2signature: 'signature',
            }),
        ).resolves.toEqual({ status: 'REFUND_FAILED' });
    });

    // Nếu history xác nhận trước IPN, redirect chỉ hoàn tất giao diện khi khớp orderInfo và thời điểm đã lưu.
    it('should return PAID for a matching history-confirmed payment', async () => {
        const confirmedAt = new Date('2026-11-17T05:00:01.000Z');
        const target = createTarget({
            merchantReference: 'ORDER_1',
            orderId: 'order-internal',
            amount: '120000.00',
            status: 'PAID',
            providerOrderInfo: 'Thanh toan don BIN-1',
            providerTransactionId: null,
            pay2sHistoryId: '35355862',
            confirmedAt,
        });
        const query = {
            accessKey: 'access',
            amount: '120000',
            message: 'success',
            orderId: 'ORDER_1',
            orderInfo: 'Thanh toan don BIN-1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: '1',
            responseTime: String(
                Math.floor(
                    new Date('2026-11-17T05:00:02.000Z').getTime() / 1000,
                ),
            ),
            resultCode: '0',
            transId: 'PAY2SJSC14E73BD6A84F3B73',
            m2signature: 'signature',
        };

        await expect(target.processPay2sReturn(query)).resolves.toEqual({
            status: 'PAID',
            orderId: 'order-internal',
        });
    });
});

describe('PaymentService history attempt selection', () => {
    // Dùng thời điểm giao dịch để lịch sử của attempt cũ không bị nhận bởi link retry tạo sau đó.
    it('selects the attempt whose payment window contains the bank transaction', () => {
        const target = Object.create(
            PaymentService.prototype,
        ) as PaymentService;
        const selectAttempt = (
            target as unknown as {
                findHistoryPaymentAttempt: (
                    attempts: never[],
                    transaction: never,
                    receivedAt: Date,
                ) => unknown;
            }
        ).findHistoryPaymentAttempt;
        const priorAttempt = {
            id: 'attempt-old',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            status: 'FAILED',
            createdAt: new Date('2026-11-17T04:00:00.000Z'),
            expiresAt: new Date('2026-11-17T04:10:00.000Z'),
            providerResponse: null,
            pay2sHistoryId: null,
        };
        const newerPendingAttempt = {
            id: 'attempt-new',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            status: 'PENDING',
            createdAt: new Date('2026-11-17T04:05:00.000Z'),
            expiresAt: new Date('2026-11-17T04:15:00.000Z'),
            providerResponse: null,
            pay2sHistoryId: null,
        };
        const transaction = {
            historyTransactionId: 'HISTORY-1',
            bankTransactionId: 'BANK-1',
            checksum: null,
            transactionDate: '2026-11-17 11:03:00',
            accountNumber: '123456',
            amount: 120000,
            description: 'Thanh toan don BIN-1',
            bank: 'MBB',
            type: 'IN',
        };
        const result = selectAttempt.call(
            target,
            [priorAttempt, newerPendingAttempt] as never,
            transaction as never,
            new Date('2026-11-17T04:03:00.000Z'),
        );

        expect(result).toBe(priorAttempt);
    });

    // Hồ sơ refund giả cũ không thể làm đích cho cron rồi sinh tiếp một hồ sơ trùng.
    it('ignores an unlinked legacy history refund attempt', () => {
        const target = Object.create(
            PaymentService.prototype,
        ) as PaymentService;
        const selectAttempt = (
            target as unknown as {
                findHistoryPaymentAttempt: (
                    attempts: never[],
                    transaction: never,
                    receivedAt: Date,
                ) => unknown;
            }
        ).findHistoryPaymentAttempt;
        const legacyAttempt = {
            id: 'legacy-refund',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            status: 'REFUND_PENDING',
            createdAt: new Date('2026-11-17T04:00:00.000Z'),
            expiresAt: new Date('2026-11-17T04:10:00.000Z'),
            providerResponse: { source: 'PAY2S_TRANSACTION_HISTORY' },
            pay2sHistoryId: null,
        };
        const transaction = {
            historyTransactionId: 'HISTORY-1',
            bankTransactionId: 'BANK-1',
            checksum: null,
            transactionDate: '2026-11-17 11:03:00',
            accountNumber: '123456',
            amount: 120000,
            description: 'Thanh toan don BIN-1',
            bank: 'MBB',
            type: 'IN',
        };

        const result = selectAttempt.call(
            target,
            [legacyAttempt] as never,
            transaction as never,
            new Date('2026-11-17T04:03:00.000Z'),
        );

        expect(result).toBeNull();
    });
});

describe('PaymentService.processPay2sIpn', () => {
    // Nếu IPN bị lỡ, lịch sử Pay2S chốt giao dịch đúng một lần và đưa khoản chuyển dư vào hàng hoàn.
    it('reconciles missing IPN and detects a second bank transfer', async () => {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Ho_Chi_Minh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const datePart = (type: string) =>
            parts.find((part) => part.type === type)?.value ?? '';
        const transactionDate = `${datePart('year')}-${datePart('month')}-${datePart('day')} ${datePart('hour')}:${datePart('minute')}:${datePart('second')}`;
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            merchantReference: 'ORDER_1',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            currency: 'VND',
            environment: 'LIVE',
            createdAt: new Date(now.getTime() - 60_000),
            expiresAt: new Date(now.getTime() + 5 * 60_000),
            status: 'PENDING',
            providerTransactionId: null as string | null,
            pay2sHistoryId: null as string | null,
        };
        const order = {
            id: 'order-1',
            ownerId: 'customer-1',
            status: 'PENDING',
            paymentStatus: 'PENDING',
            paymentMethod: 'PAY2S',
            items: [],
        };
        const duplicateAttempts: Array<Record<string, unknown>> = [];
        const attemptQuery = {
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            setLock: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([attempt]),
            getOne: jest.fn().mockResolvedValue(attempt),
            getExists: jest.fn().mockResolvedValue(false),
        };
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const where = options?.where ?? {};
                    if (typeof where.id === 'string')
                        return where.id === attempt.id
                            ? attempt
                            : (duplicateAttempts.find(
                                  (duplicate) => duplicate.id === where.id,
                              ) ?? null);
                    if (typeof where.pay2sHistoryId === 'string')
                        return (
                            [attempt, ...duplicateAttempts].find(
                                (candidate) =>
                                    candidate.pay2sHistoryId ===
                                    where.pay2sHistoryId,
                            ) ?? null
                        );
                    if (typeof where.providerTransactionId === 'string')
                        return (
                            [attempt, ...duplicateAttempts].find(
                                (candidate) =>
                                    candidate.providerTransactionId ===
                                    where.providerTransactionId,
                            ) ?? null
                        );
                    return null;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue(attemptQuery),
            create: jest.fn((value: Record<string, unknown>) => value),
            save: jest.fn(async (value: Record<string, unknown>) => {
                if (value.id === attempt.id) {
                    Object.assign(attempt, value);
                    return attempt;
                }
                duplicateAttempts.push(value);
                return value;
            }),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
            save: jest.fn(async (value: Record<string, unknown>) => {
                Object.assign(order, value);
                return order;
            }),
        };
        const historyRepository = { save: jest.fn() };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order
                    ? orderRepository
                    : entity === OrderStatusHistory
                      ? historyRepository
                      : attemptRepository,
            ),
        };
        const creditOrderPending = jest.fn().mockResolvedValue(undefined);
        const enqueueCreatedForOrder = jest.fn().mockResolvedValue(undefined);
        const publishCreated = jest.fn().mockResolvedValue(undefined);
        const checkoutCart = jest.fn().mockResolvedValue(undefined);
        const target = Object.assign(Object.create(PaymentService.prototype), {
            config: {
                get: jest.fn((key: string, fallback?: string) =>
                    key === 'PAY2S_MODE' ? 'live' : fallback,
                ),
            },
            gateway: {
                getTransactionHistory: jest.fn().mockResolvedValue([
                    {
                        historyTransactionId: 'HISTORY-1',
                        bankTransactionId: 'BANK-TRANS_1',
                        checksum: 'P2S-CHECKSUM_1',
                        transactionDate,
                        accountNumber: '123456',
                        amount: 120000,
                        description: 'Thanh toan don BIN-1',
                        bank: 'MBB',
                        type: 'IN',
                    },
                    {
                        historyTransactionId: 'HISTORY-2',
                        bankTransactionId: 'BANK-TRANS_2',
                        checksum: 'P2S-CHECKSUM_2',
                        transactionDate,
                        accountNumber: '123456',
                        amount: 120000,
                        description: 'Thanh toan don BIN-1',
                        bank: 'MBB',
                        type: 'IN',
                    },
                ]),
                createMerchantReference: jest.fn().mockReturnValue('DUP-1'),
            },
            dataSource: {
                getRepository: jest.fn((entity: unknown) =>
                    entity === Order ? orderRepository : attemptRepository,
                ),
                transaction: jest.fn((callback) => callback(manager)),
            },
            sellerWalletRepository: { creditOrderPending },
            orderEvents: { enqueueCreatedForOrder, publishCreated },
            cartClient: { checkoutCart },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const reconcile = (
            target as unknown as {
                reconcilePay2sTransactionHistory: () => Promise<void>;
            }
        ).reconcilePay2sTransactionHistory;

        await reconcile.call(target);

        expect(order.paymentStatus).toBe('PAID');
        expect(order.status).toBe('CONFIRMED');
        expect(attempt.providerTransactionId).toBeNull();
        expect(attempt.pay2sHistoryId).toBe('HISTORY-1');
        expect(duplicateAttempts).toHaveLength(1);
        expect(duplicateAttempts[0]).toEqual(
            expect.objectContaining({
                providerTransactionId: null,
                pay2sHistoryId: 'HISTORY-2',
                pay2sBankTransactionId: 'BANK-TRANS_2',
                status: 'REFUND_PENDING',
                providerResponse: expect.objectContaining({
                    bankTransactionId: 'BANK-TRANS_2',
                    refundReason: 'DUPLICATE_PAYMENT',
                }),
            }),
        );
        expect(enqueueCreatedForOrder).toHaveBeenCalledTimes(1);
        expect(creditOrderPending).toHaveBeenCalledTimes(1);
        expect(publishCreated).toHaveBeenCalledTimes(1);
        expect(checkoutCart).toHaveBeenCalledTimes(1);

        // Quét lại cùng lịch sử không tạo hồ sơ refund thứ hai.
        (
            target as unknown as { nextHistoryReconciliationAt: number }
        ).nextHistoryReconciliationAt = 0;
        await reconcile.call(target);
        expect(duplicateAttempts).toHaveLength(1);
    });

    // IPN chốt sau lúc cron đọc PENDING; khóa lại attempt phải ghép cùng khoản thu thay vì tạo refund giả.
    it('links a concurrently confirmed history row to its IPN attempt', async () => {
        const transactionDate = '2026-11-17 12:00:00';
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            environment: 'LIVE',
            status: 'PAID',
            providerTransactionId: 'PAY2SJSC14E73BD6A84F3B73',
            pay2sHistoryId: null,
            pay2sBankTransactionId: null,
            pay2sHistoryChecksum: null,
            confirmedAt: new Date('2026-11-17T05:00:01.000Z'),
            providerResponse: {
                source: 'PAY2S_IPN',
                transId: 'PAY2SJSC14E73BD6A84F3B73',
                auditMarker: 'retain-ipn-payload',
            },
        };
        const order = {
            id: 'order-1',
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
        };
        const attemptSnapshot = {
            id: attempt.id,
            orderId: attempt.orderId,
            providerOrderInfo: attempt.providerOrderInfo,
            amount: attempt.amount,
            environment: attempt.environment,
            status: 'PENDING',
            providerTransactionId: null,
            pay2sHistoryId: null,
            createdAt: new Date('2026-11-17T04:55:00.000Z'),
            expiresAt: new Date('2026-11-17T05:05:00.000Z'),
            providerResponse: null,
        };
        const duplicateAttempts: Array<Record<string, unknown>> = [];
        const attemptQuery = {
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            setLock: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([attemptSnapshot]),
            getOne: jest.fn().mockResolvedValue(attempt),
        };
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const where = options?.where ?? {};
                    if (where.id === attempt.id) return attempt;
                    if (typeof where.pay2sHistoryId === 'string') return null;
                    if (typeof where.providerTransactionId === 'string')
                        return where.providerTransactionId ===
                            attempt.providerTransactionId
                            ? attempt
                            : null;
                    return null;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue(attemptQuery),
            create: jest.fn((value: Record<string, unknown>) => value),
            save: jest.fn(async (value: Record<string, unknown>) => {
                if (value.id === attempt.id) {
                    Object.assign(attempt, value);
                    return attempt;
                }
                duplicateAttempts.push(value);
                return value;
            }),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
        };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order ? orderRepository : attemptRepository,
            ),
        };
        const target = Object.assign(Object.create(PaymentService.prototype), {
            config: {
                get: jest.fn((key: string, fallback?: string) =>
                    key === 'PAY2S_MODE' ? 'live' : fallback,
                ),
            },
            gateway: {
                getTransactionHistory: jest.fn().mockResolvedValue([
                    {
                        historyTransactionId: '35355862',
                        bankTransactionId: 'FT26320312803220',
                        checksum: 'd08f3e4c48c72a6cee13d1dc3247abea',
                        transactionDate,
                        accountNumber: '123456',
                        amount: 120000,
                        description: 'Thanh toan don BIN-1',
                        bank: 'MBB',
                        type: 'IN',
                    },
                ]),
                createMerchantReference: jest.fn().mockReturnValue('DUP-1'),
            },
            dataSource: {
                getRepository: jest.fn().mockReturnValue(attemptRepository),
                transaction: jest.fn((callback) => callback(manager)),
            },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const reconcile = (
            target as unknown as {
                reconcilePay2sTransactionHistory: () => Promise<void>;
            }
        ).reconcilePay2sTransactionHistory;

        await reconcile.call(target);

        expect(duplicateAttempts).toHaveLength(0);
        expect(attempt.providerTransactionId).toBe('PAY2SJSC14E73BD6A84F3B73');
        expect(attempt.pay2sHistoryId).toBe('35355862');
        expect(attempt.pay2sBankTransactionId).toBe('FT26320312803220');
        expect(attempt.status).toBe('PAID');
        expect(attempt.providerResponse).toEqual(
            expect.objectContaining({
                source: 'PAY2S_IPN',
                transId: 'PAY2SJSC14E73BD6A84F3B73',
                auditMarker: 'retain-ipn-payload',
                pay2sHistory: expect.objectContaining({
                    historyTransactionId: '35355862',
                    bankTransactionId: 'FT26320312803220',
                }),
            }),
        );
        expect(attemptQuery.addSelect).toHaveBeenCalledTimes(2);
    });

    // Khi lịch sử đến trước IPN, callback sau đó gắn transId thật vào attempt đã được xác nhận.
    it('links a later IPN to an already reconciled history payment', async () => {
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            merchantReference: 'ORDER_1',
            providerOrderInfo: 'Thanh toan don BIN-1',
            amount: '120000.00',
            currency: 'VND',
            environment: 'LIVE',
            expiresAt: new Date('2026-11-17T05:10:00.000Z'),
            confirmedAt: new Date('2026-11-17T05:00:01.000Z'),
            status: 'PAID',
            providerTransactionId: null as string | null,
            pay2sHistoryId: '35355862',
            providerResponse: { source: 'PAY2S_TRANSACTION_HISTORY' },
        };
        const order = {
            id: 'order-1',
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
        };
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const where = options?.where ?? {};
                    if (where.merchantReference === 'ORDER_1') return attempt;
                    if (where.id === attempt.id) return attempt;
                    if (typeof where.providerTransactionId === 'string')
                        return null;
                    return null;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue({
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                setLock: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockResolvedValue(attempt),
            }),
            save: jest.fn(async (value: Record<string, unknown>) => {
                Object.assign(attempt, value);
                return attempt;
            }),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
        };
        const target = Object.assign(Object.create(PaymentService.prototype), {
            gateway: { verifyIpn: jest.fn().mockReturnValue(true) },
            dataSource: {
                getRepository: jest.fn().mockReturnValue(attemptRepository),
                transaction: jest.fn((callback) =>
                    callback({
                        getRepository: jest.fn((entity: unknown) =>
                            entity === Order
                                ? orderRepository
                                : attemptRepository,
                        ),
                    }),
                ),
            },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const responseTime = String(
            Math.floor(new Date('2026-11-17T05:00:02.000Z').getTime() / 1000),
        );

        await expect(
            target.processPay2sIpn({
                accessKey: 'access',
                amount: '120000',
                extraData: '',
                message: 'success',
                orderId: 'ORDER_1',
                orderInfo: 'Thanh toan don BIN-1',
                orderType: 'pay2s',
                partnerCode: 'partner',
                payType: 'pay2s',
                requestId: 'REQ_1',
                responseTime,
                resultCode: '0',
                transId: 'PAY2SJSC14E73BD6A84F3B73',
                m2signature: 'signature',
            }),
        ).resolves.toEqual({ success: true });

        expect(attempt.providerTransactionId).toBe('PAY2SJSC14E73BD6A84F3B73');
        expect(attempt.status).toBe('PAID');
        expect(attemptRepository.save).toHaveBeenCalledTimes(1);
    });

    // IPN hợp lệ xác nhận order một lần; callback lặp chỉ ACK và không lặp ghi ví, event hoặc dọn cart.
    it('confirms the order once and does not replay side effects for the same transaction', async () => {
        const attemptCreatedAt = new Date(Date.now() - 60_000);
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            merchantReference: 'ORDER_1',
            amount: '120000.00',
            status: 'PENDING',
            providerTransactionId: null,
            createdAt: attemptCreatedAt,
            expiresAt: new Date(Date.now() + 5 * 60_000),
        };
        const order = {
            id: 'order-1',
            ownerId: 'customer-1',
            status: 'PENDING',
            paymentStatus: 'PENDING',
            paymentMethod: 'PAY2S',
            items: [],
        };
        const attemptQuery = {
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            setLock: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(attempt),
            getExists: jest.fn().mockResolvedValue(false),
        };
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const transactionId = options?.where?.providerTransactionId;
                    return transactionId === undefined ||
                        transactionId === attempt.providerTransactionId
                        ? attempt
                        : null;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue(attemptQuery),
            save: jest.fn(async (value: Record<string, unknown>) => {
                Object.assign(attempt, value);
                return attempt;
            }),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
            save: jest.fn(async (value: Record<string, unknown>) => {
                Object.assign(order, value);
                return order;
            }),
        };
        const historyRepository = { save: jest.fn() };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order
                    ? orderRepository
                    : entity === OrderStatusHistory
                      ? historyRepository
                      : attemptRepository,
            ),
        };
        const creditOrderPending = jest.fn().mockResolvedValue(undefined);
        const enqueueCreatedForOrder = jest.fn().mockResolvedValue(undefined);
        const publishCreated = jest.fn().mockResolvedValue(undefined);
        const checkoutCart = jest.fn().mockResolvedValue(undefined);
        const target = Object.assign(Object.create(PaymentService.prototype), {
            gateway: { verifyIpn: jest.fn().mockReturnValue(true) },
            dataSource: {
                getRepository: jest.fn((entity: unknown) =>
                    entity === Order ? orderRepository : attemptRepository,
                ),
                transaction: jest.fn((callback) => callback(manager)),
            },
            sellerWalletRepository: { creditOrderPending },
            orderEvents: { enqueueCreatedForOrder, publishCreated },
            cartClient: { checkoutCart },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const body = {
            accessKey: 'access',
            amount: '120000',
            extraData: '',
            message: 'success',
            orderId: 'ORDER_1',
            orderInfo: 'P2S1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: 'REQ_1',
            responseTime: String(Math.floor(Date.now() / 1000)),
            resultCode: '0',
            transId: 'TRANS_1',
            m2signature: 'signature',
        };

        await expect(target.processPay2sIpn(body)).resolves.toEqual({
            success: true,
        });
        await expect(target.processPay2sIpn(body)).resolves.toEqual({
            success: true,
        });

        expect(attempt.status).toBe('PAID');
        expect(attempt.providerTransactionId).toBe('TRANS_1');
        expect(order.status).toBe('CONFIRMED');
        expect(order.paymentStatus).toBe('PAID');
        expect(enqueueCreatedForOrder).toHaveBeenCalledTimes(1);
        expect(creditOrderPending).toHaveBeenCalledTimes(1);
        expect(publishCreated).toHaveBeenCalledTimes(1);
        expect(checkoutCart).toHaveBeenCalledTimes(1);
    });

    // Duplicate IPN chỉ ACK sau khi transaction xác định attempt đã PAID; event/cart không được chạy lại.
    it('does not repeat side effects for a duplicate paid IPN', async () => {
        const attempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            merchantReference: 'ORDER_1',
            amount: '120000.00',
            status: 'PAID',
            providerTransactionId: 'TRANS_1',
        };
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const transactionId = options?.where?.providerTransactionId;
                    return transactionId === undefined ||
                        transactionId === attempt.providerTransactionId
                        ? attempt
                        : null;
                },
            ),
        };
        const managerAttemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const transactionId = options?.where?.providerTransactionId;
                    return transactionId === undefined ||
                        transactionId === attempt.providerTransactionId
                        ? attempt
                        : null;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue({
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                setLock: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockResolvedValue(attempt),
            }),
        };
        const creditOrderPending = jest.fn();
        const publishCreated = jest.fn();
        const checkoutCart = jest.fn();
        const target = Object.assign(Object.create(PaymentService.prototype), {
            gateway: { verifyIpn: jest.fn().mockReturnValue(true) },
            dataSource: {
                getRepository: jest.fn().mockReturnValue(attemptRepository),
                transaction: jest.fn(async (callback) =>
                    callback({
                        getRepository: jest
                            .fn()
                            .mockReturnValue(managerAttemptRepository),
                    }),
                ),
            },
            sellerWalletRepository: {
                creditOrderPending,
            },
            orderEvents: { publishCreated },
            cartClient: { checkoutCart },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const body = {
            accessKey: 'access',
            amount: '120000',
            extraData: '',
            message: 'success',
            orderId: 'ORDER_1',
            orderInfo: 'P2S1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: 'REQ_1',
            responseTime: '1700000000',
            resultCode: '0',
            transId: 'TRANS_1',
            m2signature: 'signature',
        };

        await expect(target.processPay2sIpn(body)).resolves.toEqual({
            success: true,
        });
        expect(creditOrderPending).not.toHaveBeenCalled();
        expect(publishCreated).not.toHaveBeenCalled();
        expect(checkoutCart).not.toHaveBeenCalled();
    });

    // Khoản chuyển thứ hai phải có hồ sơ hoàn riêng; gửi lại cùng IPN không được nhân thêm hồ sơ.
    it('records a second successful transfer once without replaying paid side effects', async () => {
        const originalAttempt = {
            id: 'attempt-1',
            orderId: 'order-1',
            merchantReference: 'ORDER_1',
            amount: '120000.00',
            currency: 'VND',
            environment: 'LIVE',
            expiresAt: new Date(Date.now() + 5 * 60_000),
            status: 'PAID',
            providerTransactionId: 'TRANS_1',
        };
        const order = {
            id: 'order-1',
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
        };
        const recordedDuplicates: Array<Record<string, unknown>> = [];
        const attemptRepository = {
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const transactionId = options?.where?.providerTransactionId;
                    if (typeof transactionId === 'string')
                        return (
                            recordedDuplicates.find(
                                (duplicate) =>
                                    duplicate.providerTransactionId ===
                                    transactionId,
                            ) ?? null
                        );
                    return originalAttempt;
                },
            ),
            createQueryBuilder: jest.fn().mockReturnValue({
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                setLock: jest.fn().mockReturnThis(),
                getOne: jest.fn().mockResolvedValue(originalAttempt),
            }),
            create: jest.fn((input: Record<string, unknown>) => input),
            save: jest.fn(async (attempt: Record<string, unknown>) => {
                recordedDuplicates.push(attempt);
                return attempt;
            }),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
        };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order ? orderRepository : attemptRepository,
            ),
        };
        const creditOrderPending = jest.fn();
        const publishCreated = jest.fn();
        const checkoutCart = jest.fn();
        const target = Object.assign(Object.create(PaymentService.prototype), {
            gateway: {
                verifyIpn: jest.fn().mockReturnValue(true),
                createMerchantReference: jest.fn().mockReturnValue('DUP-1'),
            },
            dataSource: {
                getRepository: jest.fn().mockReturnValue(attemptRepository),
                transaction: jest.fn((callback) => callback(manager)),
            },
            sellerWalletRepository: { creditOrderPending },
            orderEvents: { publishCreated },
            cartClient: { checkoutCart },
            logger: { warn: jest.fn(), error: jest.fn() },
        }) as PaymentService;
        const body = {
            accessKey: 'access',
            amount: '120000',
            extraData: '',
            message: 'success',
            orderId: 'ORDER_1',
            orderInfo: 'P2S1',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: 'REQ_1',
            responseTime: '1700000000',
            resultCode: '0',
            transId: 'TRANS_2',
            m2signature: 'signature',
        };

        await expect(target.processPay2sIpn(body)).resolves.toEqual({
            success: true,
        });
        await expect(target.processPay2sIpn(body)).resolves.toEqual({
            success: true,
        });

        expect(recordedDuplicates).toHaveLength(1);
        expect(recordedDuplicates[0]).toEqual(
            expect.objectContaining({
                status: 'REFUND_PENDING',
                providerTransactionId: 'TRANS_2',
                providerResponse: expect.objectContaining({
                    refundReason: 'DUPLICATE_PAYMENT',
                }),
            }),
        );
        expect(creditOrderPending).not.toHaveBeenCalled();
        expect(publishCreated).not.toHaveBeenCalled();
        expect(checkoutCart).not.toHaveBeenCalled();
    });
});
