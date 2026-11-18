// Cấu hình thống nhất thời hạn yêu cầu hoàn sau giao thành công cho API và ví seller.

// Tiền hàng chỉ được giải phóng sau khi đủ bảy ngày để khách có thời gian mở yêu cầu hoàn.
export const ORDER_RETURN_WINDOW_DAYS = 7;
export const ORDER_RETURN_WINDOW_MS =
    ORDER_RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
