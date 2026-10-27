// Unit test cho adapter Pay2S, tập trung vào contract provider và các ràng buộc URL callback.
// Test không gọi mạng thật; mọi request HTTP đều được mock để bảo vệ startup validation an toàn.

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pay2sGatewayService } from '@/modules/order/application/services/payment/checkout/pay2s-gateway.service';

describe('Pay2sGatewayService', () => {
    const configValues: Record<string, string> = {
        PAY2S_MODE: 'sandbox',
        PAY2S_ACCESS_KEY: 'access',
        PAY2S_PARTNER_CODE: 'partner',
        PAY2S_SECRET_KEY: 'secret',
        PAY2S_PARTNER_NAME: 'Demo',
        PAY2S_BANK_ACCOUNTS_JSON:
            '[{"account_number":"123456","bank_id":"MBB"}]',
        PAY2S_CREATE_URL: 'https://payment.example.test/create',
        PAY2S_CANCEL_URL: 'https://payment.example.test/cancel',
        PAY2S_RETURN_URL: 'https://example.test/return',
        PAY2S_IPN_URL: 'https://example.test/ipn',
        PAY2S_WALLET_RETURN_URL: 'https://example.test/wallet-return',
        PAY2S_WALLET_IPN_URL: 'https://example.test/wallet-ipn',
        PAY2S_REQUEST_TIMEOUT_MS: '1000',
    };

    function createTarget(overrides: Record<string, string> = {}) {
        const config = {
            get: jest.fn(
                (key: string, fallback = '') =>
                    overrides[key] ?? configValues[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        return new Pay2sGatewayService(config);
    }

    // Kiểm tra mode disabled fail trước khi tạo request để không gọi provider khi chưa bật integration.
    it('should reject checkout when Pay2S is disabled', () => {
        // Arrange
        const target = createTarget({ PAY2S_MODE: 'disabled' });

        // Act & Assert
        expect(() => target.assertCheckoutEnabled()).toThrow(
            ServiceUnavailableException,
        );
    });

    // Local browser redirect được phép dùng localhost khi bật cờ rõ ràng, còn IPN vẫn dùng HTTPS public.
    it('should allow localhost return URLs in development when explicitly enabled', () => {
        // Arrange
        const target = createTarget({
            NODE_ENV: 'development',
            PAY2S_MODE: 'live',
            PAY2S_ALLOW_LOCAL_RETURN_URL: 'true',
            PAY2S_RETURN_URL: 'http://localhost:5173/profile/orders',
            PAY2S_WALLET_RETURN_URL:
                'http://localhost:5173/seller/finance/pay2s-return',
            PAY2S_IPN_URL: 'https://public.example.test/pay2s/ipn',
            PAY2S_WALLET_IPN_URL:
                'https://public.example.test/pay2s/wallet-ipn',
        });

        // Act & Assert
        expect(() => target.assertCheckoutEnabled()).not.toThrow();
    });

    // Không cho phép cờ local vượt qua ràng buộc HTTPS nếu process đang chạy production.
    it('should reject localhost return URLs in production', () => {
        // Arrange
        const target = createTarget({
            NODE_ENV: 'production',
            PAY2S_MODE: 'live',
            PAY2S_ALLOW_LOCAL_RETURN_URL: 'true',
            PAY2S_RETURN_URL: 'http://localhost:5173/profile/orders',
            PAY2S_WALLET_RETURN_URL:
                'http://localhost:5173/seller/finance/pay2s-return',
            PAY2S_IPN_URL: 'https://public.example.test/pay2s/ipn',
            PAY2S_WALLET_IPN_URL:
                'https://public.example.test/pay2s/wallet-ipn',
        });

        // Act & Assert
        expect(() => target.assertCheckoutEnabled()).toThrow(
            ServiceUnavailableException,
        );
    });

    // Create V2 giữ orderId ổn định, requestId riêng và extraData Base64 đúng một lần.
    it('should create a Collection Link V2 with signed metadata', async () => {
        const target = createTarget();
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                resultCode: 0,
                payUrl: 'https://pay2s.test/link',
                orderInfo: 'P2S-ORDER-INFO',
                requestId: 'REQ-1',
            }),
        } as Response);

        const result = await target.createPayment({
            orderId: 'P2S-ORDER-1',
            requestId: 'REQ-1',
            amount: '100000',
            orderInfo: 'Thanh toan don BIN-1',
            redirectUrl: 'https://example.test/return',
            ipnUrl: 'https://example.test/ipn',
            metadata: {
                invoiceType: 'none',
                customerInfo: {
                    buyerContactName: 'Buyer',
                    buyerCompanyName: '',
                    taxCode: '',
                    citizenId: '',
                    address: 'Address',
                    email: '',
                    phone: '0900000000',
                },
                items: [
                    {
                        externalItemId: 'item-1',
                        itemName: 'Item',
                        unit: 'item',
                        quantity: 1,
                        unitPrice: 100000,
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
            },
            environment: 'SANDBOX',
        });

        const [, request] = fetchMock.mock.calls[0] ?? [];
        const payload = JSON.parse(String(request?.body)) as Record<
            string,
            unknown
        >;
        expect(payload).toEqual(
            expect.objectContaining({
                orderId: 'P2S-ORDER-1',
                requestId: 'REQ-1',
                signatureVersion: '2',
                extraData: expect.any(String),
                signature: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        );
        expect(result).toEqual({
            payUrl: 'https://pay2s.test/link',
            orderInfo: 'P2S-ORDER-INFO',
            requestId: 'REQ-1',
            response: expect.any(Object),
        });
        fetchMock.mockRestore();
    });

    // Cancel dùng canonical string riêng và không bị nhầm với thao tác refund thủ công.
    it('should call the Pay2S cancel endpoint for a pending order', async () => {
        const target = createTarget();
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ resultCode: 0, status: 'CANCELLED' }),
        } as Response);

        await expect(
            target.cancelPayment({
                orderId: 'P2S-ORDER-1',
                requestId: 'CANCEL-1',
                environment: 'SANDBOX',
            }),
        ).resolves.toEqual(
            expect.objectContaining({ resultCode: '0', status: 'CANCELLED' }),
        );
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://payment.example.test/cancel',
        );
        fetchMock.mockRestore();
    });
});
