// File này định nghĩa các nguyên nhân hoàn hàng được phép; client không được tự gửi reason tùy ý.
// Quy tắc bằng chứng và phí hoàn được map từ enum này ở application service.
export enum OrderReturnReason {
  DAMAGED = "DAMAGED",
  WRONG_ITEM = "WRONG_ITEM",
  MISSING_ITEM = "MISSING_ITEM",
  NOT_AS_DESCRIBED = "NOT_AS_DESCRIBED",
  CHANGE_OF_MIND = "CHANGE_OF_MIND",
  OTHER = "OTHER",
}
