// Migration này tạo aggregate Order và các snapshot/audit record của Phase 1.

import { MigrationInterface, QueryRunner } from "typeorm";

// Tạo schema độc lập, không phụ thuộc bảng của Cart, Auth hoặc Product Service.
export class CreateOrders1787987300000 implements MigrationInterface {
  name = "CreateOrders1787987300000";

  // Dựng enum, bảng, index và constraint cần cho checkout idempotent.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE TYPE "order_status_enum" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED')`);
    await queryRunner.query(`CREATE TYPE "payment_method_enum" AS ENUM ('COD')`);
    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_number" varchar(32) NOT NULL,
        "owner_id" varchar(255) NOT NULL,
        "status" "order_status_enum" NOT NULL DEFAULT 'CONFIRMED',
        "payment_method" "payment_method_enum" NOT NULL,
        "shipping_address_id" uuid NOT NULL,
        "shipping_address" jsonb NOT NULL,
        "subtotal" numeric(14,2) NOT NULL,
        "shipping_fee" numeric(14,2) NOT NULL DEFAULT 0,
        "total_amount" numeric(14,2) NOT NULL,
        "note" varchar(500),
        "idempotency_key" varchar(128) NOT NULL,
        "request_fingerprint" varchar(700) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_orders_id" PRIMARY KEY ("id"),
        CONSTRAINT "uq_orders_order_number" UNIQUE ("order_number"),
        CONSTRAINT "ck_orders_subtotal_non_negative" CHECK ("subtotal" >= 0),
        CONSTRAINT "ck_orders_shipping_fee_non_negative" CHECK ("shipping_fee" >= 0),
        CONSTRAINT "ck_orders_total_non_negative" CHECK ("total_amount" >= 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_orders_owner_idempotency_key" ON "orders" ("owner_id", "idempotency_key")`);
    await queryRunner.query(`CREATE INDEX "idx_orders_owner_created_at" ON "orders" ("owner_id", "created_at")`);
    await queryRunner.query(`
      CREATE TABLE "order_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "variant_id" uuid NOT NULL,
        "seller_shop_id" uuid,
        "sku" varchar(160) NOT NULL,
        "product_name" varchar(500) NOT NULL,
        "variant_name" varchar(500) NOT NULL,
        "image_url" text,
        "unit_price" numeric(14,2) NOT NULL,
        "quantity" integer NOT NULL,
        "line_total" numeric(14,2) NOT NULL,
        CONSTRAINT "pk_order_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "fk_order_items_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_order_items_quantity_positive" CHECK ("quantity" >= 1),
        CONSTRAINT "ck_order_items_unit_price_non_negative" CHECK ("unit_price" >= 0),
        CONSTRAINT "ck_order_items_line_total_non_negative" CHECK ("line_total" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_order_items_order_id" ON "order_items" ("order_id")`);
    await queryRunner.query(`
      CREATE TABLE "order_status_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_id" uuid NOT NULL,
        "from_status" "order_status_enum",
        "to_status" "order_status_enum" NOT NULL,
        "reason" varchar(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_order_status_history_id" PRIMARY KEY ("id"),
        CONSTRAINT "fk_order_status_history_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_order_status_history_order_id" ON "order_status_history" ("order_id", "created_at")`);
  }

  // Rollback toàn bộ schema do migration này sở hữu theo thứ tự phụ thuộc.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "order_status_history"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "payment_method_enum"`);
    await queryRunner.query(`DROP TYPE "order_status_enum"`);
  }
}
