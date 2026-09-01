// Trạng thái request trả hàng/hoàn tiền mô phỏng, độc lập với payment status của order.
export enum OrderReturnStatus {
  REQUESTED = "REQUESTED",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  REFUNDED = "REFUNDED",
}
