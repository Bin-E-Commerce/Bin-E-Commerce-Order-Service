// Tạo và xác minh chữ ký HMAC cho request/response của API Kênh Chi payOS.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Chuẩn hóa object theo thứ tự key, giữ nguyên thứ tự mảng và mã hóa giá trị như SDK chính thức payOS.
function sortPayosSignatureValue(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map((item) => sortPayosSignatureValue(item));
    if (typeof value !== 'object' || value === null) return value;

    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, sortPayosSignatureValue(item)]),
    );
}

// Ký dữ liệu payout theo quy tắc HMAC-SHA256 của payOS; chữ ký payment request dùng định dạng khác.
export function createPayosPayoutSignature(
    checksumKey: string,
    data: Record<string, unknown>,
): string {
    const sortedData = sortPayosSignatureValue(data) as Record<string, unknown>;
    const canonicalData = Object.entries(sortedData)
        .map(([key, value]) => {
            const normalizedValue =
                value === null || value === undefined
                    ? ''
                    : Array.isArray(value) || typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value);
            return `${encodeURIComponent(key)}=${encodeURIComponent(normalizedValue)}`;
        })
        .join('&');

    return createHmac('sha256', checksumKey)
        .update(canonicalData)
        .digest('hex');
}

// So sánh chữ ký ở dạng hex bằng constant-time để response provider giả không thể chốt ledger.
export function verifyPayosPayoutSignature(
    checksumKey: string,
    data: Record<string, unknown>,
    receivedSignature: string,
): boolean {
    if (!/^[a-f\d]{64}$/i.test(receivedSignature)) return false;
    const expected = Buffer.from(
        createPayosPayoutSignature(checksumKey, data),
        'hex',
    );
    const received = Buffer.from(receivedSignature, 'hex');
    return (
        expected.length === received.length &&
        timingSafeEqual(expected, received)
    );
}
