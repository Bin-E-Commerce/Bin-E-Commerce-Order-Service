// Chuẩn hóa mã rút tiền để ngân hàng giữ nguyên một khóa đối soát duy nhất trong nội dung chuyển khoản.

// Tạo memo chỉ gồm chữ và số từ UUID; toàn bộ UUID tránh va chạm giữa các lần seller rút.
export function createWithdrawalTransferMemo(withdrawalId: string): string {
    const hexId = withdrawalId.replaceAll('-', '').toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(hexId))
        throw new Error('Invalid withdrawal identifier');
    return `RUT${hexId}`;
}

// Tách UUID từ nội dung ngân hàng có thể thêm dấu cách hoặc tiền tố, nhưng yêu cầu khớp đủ 128 bit.
export function findWithdrawalIdInTransferMemo(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const match = normalized.match(/RUT([0-9A-F]{32})/);
    if (!match) return null;
    const hexId = match[1];
    if (!hexId) return null;
    return `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`;
}
