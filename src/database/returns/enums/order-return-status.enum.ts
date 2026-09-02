// Trạng thái request trả hàng/hoàn tiền mô phỏng, độc lập với payment status của order.
export enum OrderReturnStatus {
  REQUESTED = "REQUESTED",
  CUSTOMER_CANCELLED = "CUSTOMER_CANCELLED",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  AWAITING_SHIPMENT = "AWAITING_SHIPMENT",
  IN_TRANSIT = "IN_TRANSIT",
  SHIPMENT_FAILED = "SHIPMENT_FAILED",
  RECEIVED = "RECEIVED",
  INSPECTION_FAILED = "INSPECTION_FAILED",
  REFUND_PENDING = "REFUND_PENDING",
}

// Các trạng thái này giữ một quy trình hoàn hàng đang mở theo từng order và shop.
export const ACTIVE_ORDER_RETURN_STATUSES: readonly OrderReturnStatus[] = [
  OrderReturnStatus.REQUESTED,
  OrderReturnStatus.AWAITING_SHIPMENT,
  OrderReturnStatus.IN_TRANSIT,
  OrderReturnStatus.SHIPMENT_FAILED,
  OrderReturnStatus.RECEIVED,
  OrderReturnStatus.REFUND_PENDING,
];
