// Tạo memo ngắn để các app ngân hàng có thể giữ trọn mã khi quét VietQR.
import { randomBytes } from 'node:crypto';
import type { WithdrawalTransferLookup } from '@/modules/order/application/types/payments/pay2s-payout.type';

// Sinh 80 bit ngẫu nhiên trong giới hạn 23 ký tự; unique index ở DB bảo vệ khóa đối soát khỏi va chạm.
export function createWithdrawalTransferMemoCode(): string {
    return `RUT${randomBytes(10).toString('hex').toUpperCase()}`;
}

// Trả mã đã lưu cho payout mới, còn hàng cũ tiếp tục dùng memo UUID đầy đủ để không phá giao dịch đang chạy.
export function createWithdrawalTransferMemo(
    withdrawalId: string,
    transferMemoCode?: string | null,
): string {
    const normalizedCode = transferMemoCode?.trim().toUpperCase();
    if (normalizedCode && /^RUT[A-F0-9]{20}$/.test(normalizedCode))
        return normalizedCode;

    const hexId = withdrawalId.replaceAll('-', '').toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(hexId))
        throw new Error('Invalid withdrawal identifier');
    return `RUT${hexId}`;
}

// Nhận diện mã mới trước theo định dạng ngắn, còn UUID cũ được ưu tiên để giữ tương thích các yêu cầu đã gửi.
export function findWithdrawalTransferLookupInMemo(
    value: unknown,
): WithdrawalTransferLookup | null {
    if (typeof value !== 'string') return null;
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const legacyMatch = normalized.match(/RUT([0-9A-F]{32})/);
    if (legacyMatch?.[1]) {
        const hexId = legacyMatch[1];
        return {
            withdrawalId: `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`,
        };
    }

    const shortCodeMatch = normalized.match(/RUT([0-9A-F]{20})/);
    if (!shortCodeMatch?.[1]) return null;
    return { transferMemoCode: `RUT${shortCodeMatch[1]}` };
}
