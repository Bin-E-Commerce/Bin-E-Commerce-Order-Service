// File này giữ mã nguyên nhân hoàn hàng ổn định cho API và dữ liệu lịch sử.
// OTHER chỉ còn để đọc/xử lý request cũ; customer không được tạo lý do này mới.
export enum OrderReturnReason {
    DAMAGED = 'DAMAGED',
    WRONG_ITEM = 'WRONG_ITEM',
    MISSING_ITEM = 'MISSING_ITEM',
    NOT_AS_DESCRIBED = 'NOT_AS_DESCRIBED',
    CHANGE_OF_MIND = 'CHANGE_OF_MIND',
    OTHER = 'OTHER',
}

// Allowlist này là hợp đồng cho request mới từ customer; OTHER vẫn nằm trong enum để không làm hỏng lịch sử.
export const CUSTOMER_ORDER_RETURN_REASONS = [
    OrderReturnReason.DAMAGED,
    OrderReturnReason.WRONG_ITEM,
    OrderReturnReason.MISSING_ITEM,
    OrderReturnReason.NOT_AS_DESCRIBED,
    OrderReturnReason.CHANGE_OF_MIND,
] as const;
