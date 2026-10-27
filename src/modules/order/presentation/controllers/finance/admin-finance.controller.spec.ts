// Kiểm tra cổng xử lý payout chỉ mở đối soát khi cấu hình SePay sẵn sàng và admin hiểu thao tác thủ công.
import {
    BadRequestException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import type { SepayPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/sepay-payout-reconciliation.service';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import { AdminFinanceController } from '@/modules/order/presentation/controllers/finance/admin-finance.controller';

describe('AdminFinanceController payout', () => {
    const withdrawalId = '87170a5e-c911-4ba7-9208-37199511aee0';
    let target: AdminFinanceController;
    let mockReadiness: jest.Mock;
    let mockTransition: jest.Mock;

    // Mỗi case dùng mock riêng để kiểm tra không ghi trạng thái khi điều kiện chưa đạt.
    beforeEach(() => {
        mockReadiness = jest.fn().mockReturnValue({ ready: true, missing: [] });
        mockTransition = jest.fn().mockResolvedValue(undefined);
        target = new AdminFinanceController(
            {} as PaymentService,
            {
                getReadiness: mockReadiness,
            } as unknown as SepayPayoutReconciliationService,
            {
                transitionWithdrawal: mockTransition,
            } as unknown as SellerWalletRepositoryPort,
        );
    });

    // Cấu hình thiếu phải chặn trước database, tránh treo khoản giữ chỗ ở PROCESSING.
    it('should reject processing when payout webhook is not ready', async () => {
        // Arrange
        mockReadiness.mockReturnValue({
            ready: false,
            missing: ['WEBHOOK_API_KEY'],
        });

        // Act and assert
        await expect(
            target.markWithdrawalProcessing(
                'admin-1',
                'admin.finance.payout',
                withdrawalId,
                { manualTransferAcknowledged: true },
            ),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mockTransition).not.toHaveBeenCalled();
    });

    // API phải từ chối cả khi browser bỏ qua xác nhận về việc chuyển tiền qua ngân hàng.
    it('should reject processing without manual-transfer acknowledgement', async () => {
        // Act and assert
        await expect(
            target.markWithdrawalProcessing(
                'admin-1',
                'admin.finance.payout',
                withdrawalId,
                {},
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockTransition).not.toHaveBeenCalled();
    });

    // Mở đối soát trước khi chuyển để webhook tới ngay sau giao dịch vẫn có thể chốt PAID.
    it('should arm reconciliation after manual-transfer acknowledgement', async () => {
        // Act
        const result = await target.markWithdrawalProcessing(
            'admin-1',
            'admin.finance.payout',
            withdrawalId,
            { manualTransferAcknowledged: true, note: 'Bank transfer planned' },
        );

        // Assert
        expect(result).toEqual({ updated: true });
        expect(mockTransition).toHaveBeenCalledTimes(1);
        expect(mockTransition).toHaveBeenCalledWith({
            withdrawalId,
            adminId: 'admin-1',
            status: 'PROCESSING',
            note: 'Bank transfer planned',
        });
    });
});
