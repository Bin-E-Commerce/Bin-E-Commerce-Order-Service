// Enum này là trạng thái vận hành đơn hàng; tách khỏi trạng thái thanh toán để COD không bị hiểu là chờ trả tiền.
export enum OrderFulfillmentStatus {
  TO_SHIP = "TO_SHIP",
  SHIPPING = "SHIPPING",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  DELIVERY_FAILED = "DELIVERY_FAILED",
  RETURN_REFUND = "RETURN_REFUND",
}
