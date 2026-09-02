// Migration này sửa dữ liệu của migration trước: issue sau giao hàng phải ở nhóm RETURN_REFUND, không phải Đã hủy.
// CANCELLED chỉ dành cho order được hủy trước khi shipper lấy hàng.

import { MigrationInterface, QueryRunner } from "typeorm";

export class RestoreReturnRefundStage1788016000000 implements MigrationInterface {
  name = "RestoreReturnRefundStage1788016000000";

  // Đưa các order ISSUE_REPORTED đã bị đánh dấu nhầm về nhóm Trả hàng/Hoàn tiền.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "orders"
      SET
        "status" = 'CONFIRMED'::"order_status_enum",
        "fulfillment_status" = 'RETURN_REFUND'::"order_fulfillment_status_enum",
        "cancel_reason" = NULL,
        "cancelled_at" = NULL
      WHERE "delivery_confirmation_status" = 'ISSUE_REPORTED'::"order_delivery_confirmation_status_enum"
        AND "status" = 'CANCELLED'::"order_status_enum"
        AND "fulfillment_status" = 'CANCELLED'::"order_fulfillment_status_enum"
    `);
  }

  // Rollback chỉ hoàn tác những dòng issue đã được migration này sửa.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "orders"
      SET
        "status" = 'CANCELLED'::"order_status_enum",
        "fulfillment_status" = 'CANCELLED'::"order_fulfillment_status_enum"
      WHERE "delivery_confirmation_status" = 'ISSUE_REPORTED'::"order_delivery_confirmation_status_enum"
        AND "status" = 'CONFIRMED'::"order_status_enum"
        AND "fulfillment_status" = 'RETURN_REFUND'::"order_fulfillment_status_enum"
    `);
  }
}
