// File này mở rộng schema return đã tồn tại; migration cũ được giữ nguyên để rollback lịch sử an toàn.
import { MigrationInterface, QueryRunner } from "typeorm";

export class ExpandOrderReturns1788010000000 implements MigrationInterface {
  name = "ExpandOrderReturns1788010000000";
  // Enum value phải được commit riêng trước khi migration khác dùng nó trong UPDATE.
  transaction = false;

  // Bổ sung state, snapshot bằng chứng, inspection và dữ liệu xác nhận hoàn tiền.
  async up(queryRunner: QueryRunner): Promise<void> {
    const statuses = [
      "CUSTOMER_CANCELLED", "AWAITING_SHIPMENT", "IN_TRANSIT", "SHIPMENT_FAILED",
      "RECEIVED", "INSPECTION_PASSED", "INSPECTION_FAILED", "REFUND_PENDING", "REFUND_FAILED",
    ];
    for (const status of statuses) {
      await queryRunner.query(`ALTER TYPE "order_return_status_enum" ADD VALUE IF NOT EXISTS '${status}'`);
    }
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_amount" numeric(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_shipping_amount" numeric(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "return_shipping_fee" numeric(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "seller_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "inspection_passed" boolean`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "inspection_note" varchar(1000)`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "inspected_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_method" varchar(40)`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_transaction_reference" varchar(180)`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_proof" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_processed_by" uuid`);
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_processed_at" timestamptz`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_order_returns_status_created_at" ON "order_return_requests" ("status", "created_at")`);
  }

  // Xóa đúng các index/cột mở rộng; không xóa bảng return gốc do migration này không sở hữu bảng đó.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_order_returns_status_created_at"`);
    for (const column of ["refund_processed_at", "refund_processed_by", "refund_proof", "refund_transaction_reference", "refund_method", "inspected_at", "inspection_note", "inspection_passed", "seller_user_id", "return_shipping_fee", "refund_shipping_amount", "refund_amount", "evidence"]) {
      await queryRunner.query(`ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
