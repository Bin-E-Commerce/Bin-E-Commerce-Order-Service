// Migration bổ sung fulfillment/payment state và dữ liệu phí vận chuyển snapshot cho Phase 4.
import { MigrationInterface, QueryRunner } from "typeorm";

// Migration này backfill dữ liệu cũ theo nguyên tắc an toàn, không thay đổi tổng tiền đã ghi nhận.
export class AddOrderLifecycle1788004000000 implements MigrationInterface {
  name = "AddOrderLifecycle1788004000000";

  // Tạo enum/cột/index rồi ánh xạ trạng thái cũ sang model tách payment và fulfillment.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "order_fulfillment_status_enum" AS ENUM ('TO_SHIP','SHIPPING','COMPLETED','CANCELLED','DELIVERY_FAILED','RETURN_REFUND')`);
    await queryRunner.query(`CREATE TYPE "payment_status_enum" AS ENUM ('COD_PENDING_COLLECTION','PAID','REFUND_PENDING','REFUNDED')`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "fulfillment_status" "order_fulfillment_status_enum" NOT NULL DEFAULT 'TO_SHIP'`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "payment_status" "payment_status_enum" NOT NULL DEFAULT 'COD_PENDING_COLLECTION'`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "shipping_fee_breakdown" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "completed_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "return_window_until" timestamptz`);
    await queryRunner.query(`UPDATE "orders" SET "fulfillment_status" = CASE "status"::text WHEN 'CANCELLED' THEN 'CANCELLED'::"order_fulfillment_status_enum" WHEN 'FAILED' THEN 'DELIVERY_FAILED'::"order_fulfillment_status_enum" ELSE 'TO_SHIP'::"order_fulfillment_status_enum" END`);
    await queryRunner.query(`CREATE INDEX "idx_orders_fulfillment_created_at" ON "orders" ("fulfillment_status", "created_at")`);
  }

  // Xóa đúng các thành phần Phase 4 theo thứ tự phụ thuộc.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_orders_fulfillment_created_at"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "return_window_until"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "completed_at"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "shipping_fee_breakdown"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "payment_status"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "fulfillment_status"`);
    await queryRunner.query(`DROP TYPE "payment_status_enum"`);
    await queryRunner.query(`DROP TYPE "order_fulfillment_status_enum"`);
  }
}
