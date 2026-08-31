// Migration tạo bảng return request cho workflow mô phỏng phase 4.
import { MigrationInterface, QueryRunner } from "typeorm";

// Tạo enum và bảng không có FK cross-service; orderId/shopId được kiểm tra ở application layer.
export class AddOrderReturnRequests1788005000000 implements MigrationInterface {
  name = "AddOrderReturnRequests1788005000000";

  // Tạo schema return request và index phục vụ seller queue.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "order_return_status_enum" AS ENUM ('REQUESTED','APPROVED','REJECTED','REFUNDED')`);
    await queryRunner.query(`CREATE TABLE "order_return_requests" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "order_id" uuid NOT NULL, "owner_id" varchar(255) NOT NULL, "shop_id" uuid NOT NULL, "item_ids" jsonb NOT NULL, "status" "order_return_status_enum" NOT NULL DEFAULT 'REQUESTED', "reason" varchar(120) NOT NULL, "description" varchar(1000), "review_note" varchar(500), "requested_at" timestamptz NOT NULL DEFAULT now(), "reviewed_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "pk_order_return_requests_id" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "idx_order_returns_order_shop_status" ON "order_return_requests" ("order_id","shop_id","status")`);
  }

  // Rollback schema theo đúng thứ tự index/table/enum.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_order_returns_order_shop_status"`);
    await queryRunner.query(`DROP TABLE "order_return_requests"`);
    await queryRunner.query(`DROP TYPE "order_return_status_enum"`);
  }
}
