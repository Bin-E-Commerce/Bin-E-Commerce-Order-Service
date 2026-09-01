// File này giữ bộ lý do delivery issue ổn định để UI, return workflow và báo cáo dùng cùng một contract.

export enum OrderDeliveryIssueReason {
  NOT_RECEIVED = "NOT_RECEIVED",
  DAMAGED = "DAMAGED",
  WRONG_ITEM = "WRONG_ITEM",
  MISSING_ITEM = "MISSING_ITEM",
  OTHER = "OTHER",
}
