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
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getExists: jest.fn().mockResolvedValue(false),
        };
        const attemptRepository = {
            find: jest.fn().mockResolvedValue([attempt]),
            findOne: jest.fn(
                async (options?: { where?: Record<string, unknown> }) => {
                    const transactionId = options?.where?.providerTransactionId;
                    if (typeof transactionId === 'string')
                        return transactionId === attempt.providerTransactionId
                            ? attempt
                            : (duplicateAttempts.find(
                                  (duplicate) =>
                                      duplicate.providerTransactionId ===
                                      transactionId,
                              ) ?? null);
                    return attempt;
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
                        transactionId: 'TRANS_1',
                        transactionDate,
                        accountNumber: '123456',
                        amount: 120000,
                        description: 'Thanh toan don BIN-1',
                        bank: 'MBB',
                        type: 'IN',
                    },
                    {
                        transactionId: 'TRANS_2',
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
        expect(attempt.providerTransactionId).toBe('TRANS_1');
        expect(duplicateAttempts).toHaveLength(1);
        expect(duplicateAttempts[0]).toEqual(
            expect.objectContaining({
                providerTransactionId: 'TRANS_2',
                status: 'REFUND_PENDING',
                providerResponse: expect.objectContaining({
                    refundReason: 'DUPLICATE_PAYMENT',
                }),
            }),
        );
        expect(enqueueCreatedForOrder).toHaveBeenCalledTimes(1);
        expect(creditOrderPending).toHaveBeenCalledTimes(1);
        expect(publishCreated).toHaveBeenCalledTimes(1);
        expect(checkoutCart).toHaveBeenCalledTimes(1);
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
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
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
