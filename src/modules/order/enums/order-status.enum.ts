// File này định nghĩa các trạng thái vòng đời đơn được Phase 1 sử dụng.

// PENDING và FAILED giữ chỗ cho các phase có workflow; Phase 1 chỉ xác nhận sau khi giữ tồn kho thành công.
export enum OrderStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}
