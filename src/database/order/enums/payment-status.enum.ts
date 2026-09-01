// Enum này mô tả vòng đời thu tiền COD độc lập với việc shop đang chuẩn bị hay giao hàng.
export enum PaymentStatus {
  COD_PENDING_COLLECTION = "COD_PENDING_COLLECTION",
  PAID = "PAID",
  REFUND_PENDING = "REFUND_PENDING",
  REFUNDED = "REFUNDED",
}
