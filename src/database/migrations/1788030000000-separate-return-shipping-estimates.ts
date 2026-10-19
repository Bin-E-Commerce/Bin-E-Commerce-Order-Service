// Migration tách quote GHN khỏi phí đã chốt và lưu riêng refund estimate/khoản phí khách còn nợ.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeparateReturnShippingEstimates1788030000000 implements MigrationInterface {
    name = 'SeparateReturnShippingEstimates1788030000000';

    // Quote cũ được giữ làm estimated cost; chỉ request đã có dấu finalized mới giữ cost như phí thực tế.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ADD COLUMN IF NOT EXISTS "estimated_refund_amount" numeric(14,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "return_shipping_estimated_cost" numeric(14,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "customer_return_shipping_receivable_amount" numeric(14,2) NOT NULL DEFAULT 0
        `);
        await queryRunner.query(`
            UPDATE "order_return_requests"
            SET "estimated_refund_amount" = "refund_amount",
                "return_shipping_estimated_cost" = "return_shipping_cost"
        `);
        await queryRunner.query(`
            UPDATE "order_return_requests"
            SET "return_shipping_payer" = CASE
                WHEN "reason" IN ('DAMAGED', 'WRONG_ITEM', 'MISSING_ITEM', 'NOT_AS_DESCRIBED') THEN 'SELLER'
                WHEN "reason" = 'CHANGE_OF_MIND' THEN 'CUSTOMER'
                ELSE NULL
            END
            WHERE "return_shipping_payer" IS NULL
        `);
        await queryRunner.query(`
            UPDATE "order_return_requests"
            SET "return_shipping_cost" = 0,
                "return_shipping_fee" = 0
            WHERE "return_shipping_finalized_at" IS NULL
        `);
    }

    // Gộp estimate về cost trước khi bỏ cột mới để rollback không mất quote đang chờ xử lý.
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "order_return_requests"
            SET "return_shipping_cost" = CASE
                WHEN "return_shipping_finalized_at" IS NULL
                    THEN "return_shipping_estimated_cost"
                ELSE "return_shipping_cost"
            END
        `);
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                DROP COLUMN IF EXISTS "estimated_refund_amount",
                DROP COLUMN IF EXISTS "return_shipping_estimated_cost",
                DROP COLUMN IF EXISTS "customer_return_shipping_receivable_amount"
        `);
    }
}
