// Kiểm tra payout chỉ chuyển sang xử lý khi cấu hình Pay2S sẵn sàng và admin xác nhận thao tác thủ công.
import {
    BadRequestException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import type { AdminRefundConfirmationService } from '@/modules/order/application/services/finance/admin-refund-confirmation.service';
import type { Pay2sPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/pay2s-payout-reconciliation.service';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletDebtService } from '@/modules/order/application/services/finance/seller-wallet-debt.service';
import { AdminFinanceController } from '@/modules/order/presentation/controllers/finance/admin-finance.controller';

describe('AdminFinanceController payout', () => {
    const withdrawalId = '87170a5e-c911-4ba7-9208-37199511aee0';
    let target: AdminFinanceController;
    let mockReadiness: jest.Mock;
    let mockTransition: jest.Mock;

    // Mock cả snapshot công nợ để controller có thể ghép overview mà không gọi repository thật.
    beforeEach(() => {
        mockReadiness = jest.fn().mockReturnValue({ ready: true, missing: [] });
        mockTransition = jest.fn().mockResolvedValue(undefined);
        target = new AdminFinanceController(
            {} as PaymentService,
            {} as AdminRefundConfirmationService,
            {
                getReadiness: mockReadiness,
            } as unknown as Pay2sPayoutReconciliationService,
            {
                transitionWithdrawal: mockTransition,
            } as unknown as SellerWalletRepositoryPort,
            {
                getAdminSummary: jest.fn().mockResolvedValue({}),
            } as unknown as SellerWalletDebtService,
        );
    });

    // Cấu hình thiếu phải chặn trước database, tránh treo khoản giữ chỗ ở PROCESSING.
    it('should reject processing when payout webhook is not ready', async () => {
        // Arrange
        mockReadiness.mockReturnValue({
            ready: false,
            missing: ['WEBHOOK_TOKEN'],
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
