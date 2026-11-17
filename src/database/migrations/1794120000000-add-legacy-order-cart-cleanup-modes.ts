// Bổ sung mode cleanup và dựng lại retry cho order Pay2S cũ còn chờ thanh toán.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLegacyOrderCartCleanupModes1794120000000
    implements MigrationInterface
{
    name = 'AddLegacyOrderCartCleanupModes1794120000000';

    // Backfill Pay2S chưa cleanup và đơn đã thu tiền; cutoff/ID khiến Cart bỏ qua dòng được tạo hoặc sửa về sau.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order_cart_cleanup_outbox"
            ADD COLUMN IF NOT EXISTS "cleanup_mode" varchar(24) NOT NULL DEFAULT 'SNAPSHOT',
            ADD COLUMN IF NOT EXISTS "cleanup_before" timestamptz
        `);
        await queryRunner.query(`
            ALTER TABLE "order_cart_cleanup_outbox"
            ADD CONSTRAINT "chk_order_cart_cleanup_mode"
                CHECK ("cleanup_mode" IN ('SNAPSHOT', 'LEGACY_ITEM_IDS', 'LEGACY_FULL_CART')),
            ADD CONSTRAINT "chk_order_cart_cleanup_cutoff"
                CHECK (
                    ("cleanup_mode" IN ('LEGACY_ITEM_IDS', 'LEGACY_FULL_CART')
                        AND "cleanup_before" IS NOT NULL)
                    OR ("cleanup_mode" = 'SNAPSHOT' AND "cleanup_before" IS NULL)
                )
        `);
        await queryRunner.query(`
            WITH legacy_orders AS (
                SELECT
                    payment_order.id AS order_id,
                    payment_order.owner_id,
                    payment_order.created_at,
                    COALESCE(payment_order.checkout_cart_item_ids, ARRAY[]::uuid[])
                        || CASE
                            WHEN payment_order.checkout_cart_item_id IS NULL
                                THEN ARRAY[]::uuid[]
                            ELSE ARRAY[payment_order.checkout_cart_item_id]
                        END AS candidate_item_ids
                FROM orders payment_order
                WHERE payment_order.payment_method = 'PAY2S'
                  AND payment_order.payment_status IN (
                      'PENDING', 'PAID', 'REFUND_PENDING', 'REFUNDED'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM order_cart_cleanup_outbox cleanup
                      WHERE cleanup.order_id = payment_order.id
                  )
            ), prepared_orders AS (
                SELECT
                    legacy_orders.order_id,
                    legacy_orders.owner_id,
                    legacy_orders.created_at,
                    ARRAY(
                        SELECT DISTINCT candidate.item_id
                        FROM unnest(legacy_orders.candidate_item_ids)
                            AS candidate(item_id)
                        WHERE candidate.item_id IS NOT NULL
                    ) AS item_ids
                FROM legacy_orders
            )
            INSERT INTO order_cart_cleanup_outbox (
                order_id,
                owner_id,
                items,
                cleanup_mode,
                cleanup_before,
                status,
                attempt_count,
                available_at,
                last_error
            )
            SELECT
                prepared.order_id,
                prepared.owner_id,
                COALESCE(
                    (
                        SELECT jsonb_agg(jsonb_build_object(
                            'itemId', selected.item_id::text,
                            'quantity', 1
                        ))
                        FROM unnest(prepared.item_ids) AS selected(item_id)
                    ),
                    '[]'::jsonb
                ),
                CASE
                    WHEN cardinality(prepared.item_ids) > 0
                        THEN 'LEGACY_ITEM_IDS'
                    ELSE 'LEGACY_FULL_CART'
                END,
                prepared.created_at,
                'PENDING',
                0,
                now(),
                NULL
            FROM prepared_orders prepared
        `);
    }

    // Không rollback mode khi còn job legacy vì phiên bản cũ không biết diễn giải an toàn payload của chúng.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "order_cart_cleanup_outbox"
            WHERE "cleanup_mode" <> 'SNAPSHOT'
               OR "cleanup_before" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0) {
            throw new Error(
                'Không thể rollback khi outbox còn cleanup cho order Pay2S legacy.',
            );
        }

        await queryRunner.query(`
            ALTER TABLE "order_cart_cleanup_outbox"
            DROP COLUMN IF EXISTS "cleanup_before",
            DROP COLUMN IF EXISTS "cleanup_mode"
        `);
    }
}
