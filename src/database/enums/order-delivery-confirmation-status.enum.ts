// File này định nghĩa kết quả xác nhận nhận hàng của khách; trạng thái này tách khỏi fulfillment để audit rõ khách đã thao tác hay hệ thống tự hoàn tất.

export enum OrderDeliveryConfirmationStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  ISSUE_REPORTED = "ISSUE_REPORTED",
  AUTO_CONFIRMED = "AUTO_CONFIRMED",
}
