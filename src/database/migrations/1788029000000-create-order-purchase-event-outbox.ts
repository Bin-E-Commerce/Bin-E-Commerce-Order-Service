import { MigrationInterface, QueryRunner } from "typeorm";

// Tạo durable outbox để purchase event không bị mất giữa order transaction và Kafka publish.
export class CreateOrderPurchaseEventOutbox1788029000000 implements MigrationInterface {
  name = "CreateOrderPurchaseEventOutbox1788029000000";

  // Payload chỉ chứa dữ liệu purchase cần cho Recommendation, không chứa payment/address nhạy cảm.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_purchase_event_outbox" (
        "event_id" varchar(255) PRIMARY KEY,
        "topic" varchar(128) NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "available_at" timestamptz NOT NULL DEFAULT now(),
        "published_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_order_purchase_event_outbox_status"
          CHECK ("status" IN ('PENDING', 'PROCESSING', 'PUBLISHED'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_order_purchase_event_outbox_pending"
      ON "order_purchase_event_outbox" ("status", "available_at")
    `);
  }

  // Xóa bảng do migration này sở hữu mà không đụng vào order data.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_purchase_event_outbox"`);
  }
}
