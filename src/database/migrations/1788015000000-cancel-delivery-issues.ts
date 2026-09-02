// Migration này sửa các order đã ghi nhận delivery issue nhưng vẫn nằm ở tab Chờ xác nhận.
// Chỉ các dòng DELIVERED + ISSUE_REPORTED do workflow mới tạo ra mới được chuẩn hóa sang CANCELLED.

import { MigrationInterface, QueryRunner } from "typeorm";

export class CancelDeliveryIssues1788015000000 implements MigrationInterface {
  name = "CancelDeliveryIssues1788015000000";

  // Đưa dữ liệu issue cũ về cùng trạng thái cuối mà API mới áp dụng cho request tiếp theo.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "orders"
      SET
        "status" = 'CANCELLED'::"order_status_enum",
        "fulfillment_status" = 'CANCELLED'::"order_fulfillment_status_enum",
        "cancel_reason" = COALESCE("cancel_reason", 'Khách hàng báo đơn hàng có vấn đề.'),
        "cancelled_at" = COALESCE("cancelled_at", NOW())
      WHERE "delivery_confirmation_status" = 'ISSUE_REPORTED'::"order_delivery_confirmation_status_enum"
        AND "fulfillment_status" = 'DELIVERED'::"order_fulfillment_status_enum"
    `);
  }

  // Khôi phục các dòng do migration này đánh dấu; thao tác chỉ dùng cho rollback local/dev.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "orders"
      SET
        "status" = 'CONFIRMED'::"order_status_enum",
        "fulfillment_status" = 'DELIVERED'::"order_fulfillment_status_enum",
        "cancel_reason" = NULL,
        "cancelled_at" = NULL
      WHERE "delivery_confirmation_status" = 'ISSUE_REPORTED'::"order_delivery_confirmation_status_enum"
        AND "status" = 'CANCELLED'::"order_status_enum"
        AND "fulfillment_status" = 'CANCELLED'::"order_fulfillment_status_enum"
        AND "cancel_reason" = 'Khách hàng báo đơn hàng có vấn đề.'
    `);
  }
}
