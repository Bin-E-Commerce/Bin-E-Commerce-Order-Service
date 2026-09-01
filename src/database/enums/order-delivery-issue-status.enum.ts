// File này định nghĩa vòng đời issue sau khi khách báo đơn giao sai, hỏng, thiếu hoặc chưa nhận được.

export enum OrderDeliveryIssueStatus {
  OPEN = "OPEN",
  RESOLVED = "RESOLVED",
  REJECTED = "REJECTED",
}
