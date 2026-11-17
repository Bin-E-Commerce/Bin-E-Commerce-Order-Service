// Lưu selection item và cleanup outbox để retry cart cleanup sau lỗi mạng hoặc restart.
// Các cột nullable giữ tương thích với order cũ vốn checkout toàn cart hoặc một item.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderCheckoutCartItemIds1794110000000 implements MigrationInterface {
    name = 'AddOrderCheckoutCartItemIds1794110000000';

    // Cột UUID array cho phép lưu selection nhiều dòng mà không đổi dữ liệu order/item đã tồn tại.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_cart_item_ids" uuid[]',
        );
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "order_cart_cleanup_outbox" (
                "order_id" uuid PRIMARY KEY,
                "owner_id" varchar(255) NOT NULL,
                "items" jsonb NOT NULL,
                "status" varchar(16) NOT NULL DEFAULT 'PENDING',
                "attempt_count" integer NOT NULL DEFAULT 0,
                "available_at" timestamptz NOT NULL DEFAULT now(),
                "last_error" text,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_order_cart_cleanup_outbox_retry"
            ON "order_cart_cleanup_outbox" ("status", "available_at")
        `);
    }

    // Chặn rollback khi order còn chờ Pay2S hoặc outbox đã lưu selection mà code cũ không thể xử lý an toàn.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "orders"
            WHERE "checkout_cart_item_ids" IS NOT NULL
              AND "payment_method" = 'PAY2S'
              AND "payment_status" = 'PENDING'
        `)) as Array<{ count: number }>;
        const [outboxResult] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count FROM "order_cart_cleanup_outbox"
        `)) as Array<{ count: number }>;
        if (
            Number(result?.count ?? 0) > 0 ||
            Number(outboxResult?.count ?? 0) > 0
        ) {
            throw new Error(
                'Không thể rollback khi order còn cần selection cart hoặc cleanup outbox.',
            );
        }

        await queryRunner.query(
            'DROP INDEX IF EXISTS "idx_order_cart_cleanup_outbox_retry"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "order_cart_cleanup_outbox"',
        );
        await queryRunner.query(
            'ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkout_cart_item_ids"',
        );
    }
}
