// Migration này bổ sung trạng thái đã giao, xác nhận nhận hàng và delivery issue cho customer order flow.
// Các cột mới độc lập với payment status để việc khách bỏ qua review không ảnh hưởng đến thanh toán hoặc lifecycle.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeliveryConfirmation1788007000000 implements MigrationInterface {
  name = "AddDeliveryConfirmation1788007000000";

  // Tạo enum, cột, issue table và backfill order cũ theo hướng không làm mất dữ liệu lịch sử.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "order_fulfillment_status_enum" ADD VALUE IF NOT EXISTS 'DELIVERED'`);
    await queryRunner.query(`CREATE TYPE "order_delivery_confirmation_status_enum" AS ENUM ('PENDING','CONFIRMED','ISSUE_REPORTED','AUTO_CONFIRMED')`);
    await queryRunner.query(`CREATE TYPE "order_delivery_confirmation_method_enum" AS ENUM ('CUSTOMER','AUTO')`);
    await queryRunner.query(`CREATE TYPE "order_delivery_issue_reason_enum" AS ENUM ('NOT_RECEIVED','DAMAGED','WRONG_ITEM','MISSING_ITEM','OTHER')`);
    await queryRunner.query(`CREATE TYPE "order_delivery_issue_status_enum" AS ENUM ('OPEN','RESOLVED','REJECTED')`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "delivery_confirmation_status" "order_delivery_confirmation_status_enum" NOT NULL DEFAULT 'PENDING'`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "delivery_confirmation_method" "order_delivery_confirmation_method_enum"`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "delivered_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "delivery_confirmation_deadline" timestamptz`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "delivery_confirmed_at" timestamptz`);
    await queryRunner.query(`
      CREATE TABLE "order_delivery_issues" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_id" uuid NOT NULL,
        "owner_id" varchar(255) NOT NULL,
        "reason" "order_delivery_issue_reason_enum" NOT NULL,
        "item_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "note" varchar(1000),
        "status" "order_delivery_issue_status_enum" NOT NULL DEFAULT 'OPEN',
        "return_request_id" uuid,
        "resolved_at" timestamptz,
        "resolution_note" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_order_delivery_issues_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_order_delivery_issues_order_status" ON "order_delivery_issues" ("order_id", "status")`);
    await queryRunner.query(`CREATE INDEX "idx_orders_delivery_confirmation_deadline" ON "orders" ("fulfillment_status", "delivery_confirmation_deadline")`);
    await queryRunner.query(`UPDATE "orders" SET "delivery_confirmation_status" = 'AUTO_CONFIRMED', "delivery_confirmation_method" = 'AUTO' WHERE "fulfillment_status" = 'COMPLETED'`);
  }

  // Xóa bảng/index/cột theo đúng thứ tự phụ thuộc khi rollback migration.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_orders_delivery_confirmation_deadline"`);
    await queryRunner.query(`DROP INDEX "idx_order_delivery_issues_order_status"`);
    await queryRunner.query(`DROP TABLE "order_delivery_issues"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "delivery_confirmed_at"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "delivery_confirmation_deadline"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "delivered_at"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "delivery_confirmation_method"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "delivery_confirmation_status"`);
    await queryRunner.query(`DROP TYPE "order_delivery_issue_status_enum"`);
    await queryRunner.query(`DROP TYPE "order_delivery_issue_reason_enum"`);
    await queryRunner.query(`DROP TYPE "order_delivery_confirmation_method_enum"`);
    await queryRunner.query(`DROP TYPE "order_delivery_confirmation_status_enum"`);
  }
}
