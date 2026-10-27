import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';

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
            findOne: jest.fn().mockResolvedValue(attempt),
        };
        const managerAttemptRepository = {
            findOne: jest.fn().mockResolvedValue(attempt),
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
});
