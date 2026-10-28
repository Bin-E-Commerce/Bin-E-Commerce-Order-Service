// Kiểm tra điều kiện cấu hình webhook trước khi cho phép admin đối soát chuyển tiền ra.
import type { ConfigService } from '@nestjs/config';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import { Pay2sPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/pay2s-payout-reconciliation.service';

describe('Pay2sPayoutReconciliationService readiness', () => {
    let target: Pay2sPayoutReconciliationService;
    let mockGet: jest.Mock;

    // Cấu hình trả về theo tên biến để mỗi test chỉ thay điều kiện đang xét.
    beforeEach(() => {
        mockGet = jest.fn((key: string) => {
            if (key === 'PAY2S_PAYOUT_WEBHOOK_TOKEN') return 'test-secret';
            if (key === 'PAY2S_PAYOUT_SOURCE_ACCOUNT_NUMBER')
                return '0123456789';
            return '';
        });
        target = new Pay2sPayoutReconciliationService(
            { get: mockGet } as unknown as ConfigService,
            {} as SellerWalletRepositoryPort,
        );
    });

    // Chỉ báo sẵn sàng khi cả khóa xác thực và tài khoản nguồn đều có dạng hợp lệ.
    it('should report ready when payout settings are present', () => {
        // Act
        const result = target.getReadiness();

        // Assert
        expect(result).toEqual({ ready: true, missing: [] });
    });

    // Thiếu cấu hình phải hiện đúng hạng mục, không đưa giá trị bí mật về admin UI.
    it('should list missing settings without exposing their values', () => {
        // Arrange
        mockGet.mockReturnValue('');

        // Act
        const result = target.getReadiness();

        // Assert
        expect(result).toEqual({
            ready: false,
            missing: ['WEBHOOK_TOKEN', 'SOURCE_ACCOUNT_NUMBER'],
        });
    });

    // Ký tự khác chữ số có thể khiến webhook khớp nhầm tài khoản nên chặn ngay từ readiness.
    it('should reject a malformed source account', () => {
        // Arrange
        mockGet.mockImplementation((key: string) =>
            key === 'PAY2S_PAYOUT_WEBHOOK_TOKEN'
                ? 'test-secret'
                : 'abc0123456789',
        );

        // Act
        const result = target.getReadiness();

        // Assert
        expect(result).toEqual({
            ready: false,
            missing: ['SOURCE_ACCOUNT_NUMBER'],
        });
    });
});
