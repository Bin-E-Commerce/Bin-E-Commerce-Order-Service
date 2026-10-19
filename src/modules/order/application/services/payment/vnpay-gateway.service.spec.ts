// Kiểm thử quy tắc bật gateway để checkout bị chặn trước mọi side effect khi cấu hình chưa an toàn.
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VnpayGatewayService } from '@/modules/order/application/services/payment/vnpay-gateway.service';

describe('VnpayGatewayService', () => {
    // Giữ cấu hình có thể thay đổi trong từng ca để kiểm tra mặc định fail-closed.
    const createTarget = (values: Record<string, string>) => {
        const mockConfig = {
            get: jest.fn(
                (key: string, fallback?: string) => values[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        return new VnpayGatewayService(mockConfig);
    };

    // Không để bật checkout nếu merchant chưa cấu hình; caller có thể từ chối trước reserve tồn kho.
    it('rejects when VNPay is disabled', () => {
        const target = createTarget({ VNPAY_MODE: 'disabled' });

        expect(() => target.assertCheckoutEnabled()).toThrow(
            ServiceUnavailableException,
        );
    });

    // NODE_ENV production không đổi contract của đồ án; Sandbox dùng credentials riêng và callback vẫn xác minh đầy đủ.
    it('allows configured sandbox mode in production', () => {
        const target = createTarget({
            NODE_ENV: 'production',
            VNPAY_MODE: 'sandbox',
            VNPAY_SANDBOX_TMN_CODE: 'TESTMERCHANT',
            VNPAY_SANDBOX_HASH_SECRET: 'test-secret',
            VNPAY_RETURN_URL: 'https://example.test/payments/vnpay/return',
            VNPAY_SANDBOX_URL:
                'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
        });

        expect(() => target.assertCheckoutEnabled()).not.toThrow();
    });

    // Cần đủ merchant, secret, return URL và endpoint trước khi khách tạo order có payment attempt.
    it('rejects incomplete sandbox credentials', () => {
        const target = createTarget({ VNPAY_MODE: 'sandbox' });

        expect(() => target.assertCheckoutEnabled()).toThrow(
            ServiceUnavailableException,
        );
    });
});
