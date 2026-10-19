// Tiện ích chuẩn hóa và xác thực chữ ký VNPay; không chứa cấu hình hoặc gửi request mạng.
import { createHmac, timingSafeEqual } from 'node:crypto';

// VNPay dùng cách encode kiểu application/x-www-form-urlencoded trong canonical checksum.
// Dùng cùng encoder cho checksum và query string để dấu cách/ký tự đặc biệt không tạo chữ ký lệch.
export function encodeVnpayValue(value: string): string {
    return encodeURIComponent(value)
        .replace(/%20/g, '+')
        .replace(
            /[!'()*~]/g,
            (character) =>
                `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
}

// Chuẩn hóa parameter theo thứ tự từ điển để chữ ký tạo và nhận dùng cùng một canonical representation.
export function createVnpaySignature(
    params: Record<string, string | number | undefined>,
    secret: string,
): string {
    const canonical = Object.entries(params)
        .filter(
            ([key, value]) =>
                !['vnp_SecureHash', 'vnp_SecureHashType'].includes(key) &&
                value !== undefined,
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
            ([key, value]) =>
                `${encodeVnpayValue(key)}=${encodeVnpayValue(String(value))}`,
        )
        .join('&');
    return createHmac('sha512', secret).update(canonical).digest('hex');
}

// So sánh hash theo thời gian cố định và từ chối chuỗi sai định dạng trước khi so byte.
export function verifyVnpaySignature(
    params: Record<string, string | number | undefined>,
    secret: string,
): boolean {
    const received = String(params.vnp_SecureHash ?? '').toLowerCase();
    if (!/^[a-f0-9]{128}$/.test(received) || !secret) return false;

    const expected = createVnpaySignature(params, secret);
    return timingSafeEqual(
        Buffer.from(received, 'hex'),
        Buffer.from(expected, 'hex'),
    );
}
