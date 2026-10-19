// Kiểm thử chữ ký VNPay độc lập để bắt sai canonical order và hành vi so sánh hash.
import {
    createVnpaySignature,
    verifyVnpaySignature,
} from '@/modules/order/application/utils/vnpay-signature.util';

describe('VNPay signature utilities', () => {
    const secret = 'sandbox-secret';

    // Xác nhận thứ tự input không ảnh hưởng chữ ký và SecureHash không tự ký lồng.
    // Thứ tự query không đổi canonical string và signature luôn có đúng độ dài SHA-512.
    it('should create the same signature for reordered parameters', () => {
        const first = createVnpaySignature(
            { vnp_Amount: 12000000, vnp_TxnRef: 'order-1' },
            secret,
        );
        const second = createVnpaySignature(
            { vnp_TxnRef: 'order-1', vnp_Amount: 12000000 },
            secret,
        );

        expect(second).toBe(first);
        expect(first).toHaveLength(128);
    });

    // Chỉ chấp nhận chữ ký đúng; hash hỏng hoặc thiếu secret đều phải fail closed.
    // Từ chối hash sai, hash bị sửa và thiếu secret để IPN luôn fail closed.
    it('should reject invalid signatures', () => {
        const valid = createVnpaySignature({ vnp_TxnRef: 'order-1' }, secret);

        expect(
            verifyVnpaySignature(
                { vnp_TxnRef: 'order-1', vnp_SecureHash: valid },
                secret,
            ),
        ).toBe(true);
        expect(
            verifyVnpaySignature(
                { vnp_TxnRef: 'order-2', vnp_SecureHash: valid },
                secret,
            ),
        ).toBe(false);
        expect(verifyVnpaySignature({ vnp_SecureHash: 'bad' }, secret)).toBe(
            false,
        );
        expect(verifyVnpaySignature({ vnp_SecureHash: valid }, '')).toBe(false);
    });

    // VNPay truyền SecureHashType kèm IPN nhưng trường này không thuộc canonical checksum.
    it('should ignore the signature type metadata when verifying callbacks', () => {
        const params = {
            vnp_TxnRef: 'order-1',
            vnp_SecureHashType: 'HMACSHA512',
        };
        const signature = createVnpaySignature(params, secret);

        expect(
            verifyVnpaySignature(
                { ...params, vnp_SecureHash: signature },
                secret,
            ),
        ).toBe(true);
    });
});
