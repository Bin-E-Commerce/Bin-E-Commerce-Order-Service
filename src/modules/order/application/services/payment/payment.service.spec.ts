// Kiểm thử kết quả Return URL để chỉ giao dịch đã xác minh mới được báo thành công cho khách.
import { PaymentService } from '@/modules/order/application/services/payment/payment.service';

describe('PaymentService.processVnpayReturn', () => {
    // Dùng prototype thật cho logic map trạng thái, còn IPN và truy vấn attempt được cô lập khỏi DB/provider.
    function createTarget(input: {
        callbackCode: string;
        attemptStatus?: string;
        providerTransactionId?: string | null;
    }) {
        const findOne = jest.fn().mockResolvedValue(
            input.attemptStatus
                ? {
                      orderId: 'order-1',
                      status: input.attemptStatus,
                      providerTransactionId:
                          input.providerTransactionId ?? 'txn-1',
                  }
                : null,
        );
        const target = Object.assign(Object.create(PaymentService.prototype), {
            dataSource: {
                getRepository: () => ({ findOne }),
            },
        }) as PaymentService;
        jest.spyOn(target, 'processVnpayIpn').mockResolvedValue({
            RspCode: input.callbackCode,
            Message: 'test',
        });

        return { target, findOne };
    }

    // Chỉ đánh dấu đã trả tiền khi ID giao dịch ký bởi VNPay trùng attempt đã lưu.
    it('returns PAID for the matching confirmed transaction', async () => {
        const { target } = createTarget({
            callbackCode: '00',
            attemptStatus: 'PAID',
        });

        await expect(
            target.processVnpayReturn({
                vnp_TxnRef: 'ref-1',
                vnp_TransactionNo: 'txn-1',
            }),
        ).resolves.toEqual({ status: 'PAID', orderId: 'order-1' });
    });

    // Giao dịch bị provider từ chối đã được IPN xác minh nhưng không được hiển thị thành công.
    it('returns FAILED for a verified failed attempt', async () => {
        const { target } = createTarget({
            callbackCode: '00',
            attemptStatus: 'FAILED',
        });

        await expect(
            target.processVnpayReturn({ vnp_TxnRef: 'ref-1' }),
        ).resolves.toEqual({ status: 'FAILED' });
    });

    // Thanh toán đến sau lúc order đóng được báo đang hoàn tiền, không được đưa sang trạng thái đã trả tiền.
    it('returns REFUND_PENDING for a late payment', async () => {
        const { target } = createTarget({
            callbackCode: '00',
            attemptStatus: 'REFUND_PENDING',
        });

        await expect(
            target.processVnpayReturn({ vnp_TxnRef: 'ref-1' }),
        ).resolves.toEqual({ status: 'REFUND_PENDING' });
    });

    // Thiếu reference hoặc chữ ký/số tiền sai phải đóng fail-closed và không truy vấn nhầm attempt.
    it('returns UNVERIFIED for malformed or rejected callbacks', async () => {
        const malformed = createTarget({ callbackCode: '00' });
        await expect(
            malformed.target.processVnpayReturn({ vnp_ResponseCode: '00' }),
        ).resolves.toEqual({ status: 'UNVERIFIED' });
        expect(malformed.findOne).not.toHaveBeenCalled();

        const rejected = createTarget({ callbackCode: '97' });
        await expect(
            rejected.target.processVnpayReturn({ vnp_TxnRef: 'ref-1' }),
        ).resolves.toEqual({ status: 'UNVERIFIED' });
        expect(rejected.findOne).not.toHaveBeenCalled();
    });

    // Một callback không thể lấy attempt đã thanh toán khác bằng reference rồi mạo nhận transaction ID.
    it('does not accept a different provider transaction ID', async () => {
        const { target } = createTarget({
            callbackCode: '00',
            attemptStatus: 'PAID',
            providerTransactionId: 'txn-original',
        });

        await expect(
            target.processVnpayReturn({
                vnp_TxnRef: 'ref-1',
                vnp_TransactionNo: 'txn-other',
            }),
        ).resolves.toEqual({ status: 'PENDING' });
    });
});

describe('PaymentService.processWalletDepositIpn', () => {
    // Mock tách biệt order PaymentAttempt khỏi ví để chỉ callback Sandbox của mã nạp mới đi vào nhánh này.
    function createWalletTarget(input: {
        validSignature: boolean;
        confirmResult?: 'PAID' | 'DUPLICATE' | 'NOT_PENDING';
    }) {
        const findAttempt = jest.fn().mockResolvedValue(null);
        const getWalletDepositByReference = jest.fn().mockResolvedValue({
            id: 'deposit-1',
            amount: '10000.00',
            status: 'PENDING',
        });
        const confirmWalletDeposit = jest
            .fn()
            .mockResolvedValue(input.confirmResult ?? 'PAID');
        const target = Object.assign(Object.create(PaymentService.prototype), {
            dataSource: {
                getRepository: () => ({ findOne: findAttempt }),
            },
            gateway: {
                verifyCallback: jest.fn().mockReturnValue(input.validSignature),
            },
            logger: { warn: jest.fn() },
            sellerWalletRepository: {
                getWalletDepositByReference,
                confirmWalletDeposit,
                failWalletDeposit: jest.fn(),
            },
        }) as PaymentService;

        return { target, confirmWalletDeposit };
    }

    // VNPAY_AMOUNT có đơn vị 1/100 VND; test này bảo vệ chữ ký, số tiền và source key idempotent.
    it('does not credit when the Sandbox signature is invalid', async () => {
        const { target, confirmWalletDeposit } = createWalletTarget({
            validSignature: false,
        });

        await expect(
            target.processVnpayIpn({
                vnp_TxnRef: 'WREF-1',
                vnp_Amount: '1000000',
                vnp_ResponseCode: '00',
                vnp_TransactionStatus: '00',
                vnp_TransactionNo: '123456',
            }),
        ).resolves.toEqual({ RspCode: '97', Message: 'Invalid signature' });
        expect(confirmWalletDeposit).not.toHaveBeenCalled();
    });

    // Amount mismatch phải bị loại trước transaction ghi số dư, dù callback có đúng chữ ký.
    it('does not credit when the callback amount differs from the saved deposit', async () => {
        const { target, confirmWalletDeposit } = createWalletTarget({
            validSignature: true,
        });

        await expect(
            target.processVnpayIpn({
                vnp_TxnRef: 'WREF-1',
                vnp_Amount: '999999',
                vnp_ResponseCode: '00',
                vnp_TransactionStatus: '00',
                vnp_TransactionNo: '123456',
            }),
        ).resolves.toEqual({ RspCode: '04', Message: 'Invalid amount' });
        expect(confirmWalletDeposit).not.toHaveBeenCalled();
    });

    // Callback trùng được ACK thành công; repository kiểm tra transaction ID và không ghi ledger lần hai.
    it.each(['PAID', 'DUPLICATE'] as const)(
        'acknowledges a valid deposit callback when repository returns %s',
        async (confirmResult) => {
            const { target, confirmWalletDeposit } = createWalletTarget({
                validSignature: true,
                confirmResult,
            });

            await expect(
                target.processVnpayIpn({
                    vnp_TxnRef: 'WREF-1',
                    vnp_Amount: '1000000',
                    vnp_ResponseCode: '00',
                    vnp_TransactionStatus: '00',
                    vnp_TransactionNo: '123456',
                    vnp_CurrCode: 'VND',
                }),
            ).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
            expect(confirmWalletDeposit).toHaveBeenCalledWith(
                expect.objectContaining({
                    depositId: 'deposit-1',
                    transactionId: '123456',
                }),
            );
        },
    );
});
