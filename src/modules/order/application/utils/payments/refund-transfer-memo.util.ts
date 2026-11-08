// Tạo và nhận dạng memo refund Pay2S.
// Parser giữ namespace riêng cho payment attempt và yêu cầu return.
import type { RefundTransferLookup } from '@/modules/order/application/types/payments/pay2s-payout.type';

// Memo 23 ký tự giữ được trên QR ngân hàng và đủ entropy để truy ra một payment attempt.
export function createRefundTransferMemo(paymentAttemptId: string): string {
    const compactId = paymentAttemptId
        .replaceAll('-', '')
        .slice(0, 18)
        .toUpperCase();
    // UUID sai định dạng phải bị chặn thay vì tạo memo không thể ghép lại an toàn ở webhook.
    if (!/^[0-9A-F]{18}$/.test(compactId))
        throw new Error('Invalid payment attempt identifier');
    return `HOAN ${compactId}`;
}

// Chuẩn hóa memo do ngân hàng có thể bỏ dấu cách.
// Mỗi prefix chỉ được ánh xạ tới đúng loại hồ sơ.
export function findRefundTransferLookupInMemo(
    value: unknown,
): RefundTransferLookup | null {
    // Webhook có thể chứa object/number thay vì nội dung; chỉ chuỗi mới được parse để không đoán dữ liệu.
    if (typeof value !== 'string') return null;
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const match = normalized.match(/HOAN([0-9A-F]{18})/);
    if (match?.[1]) return { refundTransferCode: match[1] };

    // RET chỉ định danh order return, không dùng chung HOAN.
    // Việc tách prefix ngăn webhook ghép nhầm sang payment attempt.
    const returnMatch = normalized.match(/RET([0-9A-F]{18})/);
    if (returnMatch?.[1]) return { returnTransferCode: returnMatch[1] };

    // Mã cũ dùng chính mã đơn; chỉ nhận memo ngắn bắt đầu HOANBIN, không suy ra từ nội dung dài mơ hồ.
    const legacyMatch = normalized.match(/HOAN(BIN[A-Z0-9]{1,15})$/);
    if (!legacyMatch?.[1] || normalized.length > 22) return null;
    return { legacyOrderNumberCode: legacyMatch[1] };
}
