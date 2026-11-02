// Migration bổ sung trạng thái lỗi hoàn và dữ liệu audit cho khiếu nại giao hàng được hoàn tiền thủ công.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Nâng schema hiện hữu mà không sửa dữ liệu hoặc tạo bút toán tài chính trong lúc deploy.
export class CompleteManualRefundWorkflows1793008400000 implements MigrationInterface {
    name = 'CompleteManualRefundWorkflows1793008400000';

    // Thêm trạng thái lỗi có thể retry và giữ bằng chứng chuyển khoản gắn với đúng hồ sơ nguồn.
    async up(queryRunner: QueryRunner): Promise<void> {
        const [duplicateReturn] = (await queryRunner.query(`
            SELECT "order_id", "shop_id", COUNT(*)::int AS count
            FROM "order_return_requests"
            WHERE "status" IN ('REQUESTED', 'AWAITING_SHIPMENT', 'IN_TRANSIT', 'SHIPMENT_FAILED', 'RECEIVED', 'REFUND_PENDING', 'REFUND_FAILED')
            GROUP BY "order_id", "shop_id"
            HAVING COUNT(*) > 1
            LIMIT 1
        `)) as Array<{ order_id: string; shop_id: string; count: number }>;
        if (duplicateReturn)
            throw new Error(
                `Không thể mở rộng unique return index: order ${duplicateReturn.order_id} và shop ${duplicateReturn.shop_id} có ${duplicateReturn.count} return đang hoạt động. Cần xử lý trùng trước khi migrate.`,
            );
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "shipment_failure_note" varchar(500)`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "uq_order_return_active_order_shop"`,
        );
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_order_return_active_order_shop"
            ON "order_return_requests" ("order_id", "shop_id")
            WHERE "status" IN ('REQUESTED', 'AWAITING_SHIPMENT', 'IN_TRANSIT', 'SHIPMENT_FAILED', 'RECEIVED', 'REFUND_PENDING', 'REFUND_FAILED')
        `);
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP CONSTRAINT IF EXISTS "ck_payment_attempts_status"`,
        );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD CONSTRAINT "ck_payment_attempts_status"
                CHECK ("status" IN ('PENDING','PAID','FAILED','EXPIRED','REFUND_PENDING','REFUND_FAILED','REFUNDED'))
        `);
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "refund_failure_note" varchar(500),
                ADD COLUMN IF NOT EXISTS "refund_failure_by" varchar(255)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ADD COLUMN IF NOT EXISTS "refund_failure_note" varchar(500),
                ADD COLUMN IF NOT EXISTS "refund_failure_by" varchar(255)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_delivery_issues"
                ADD COLUMN IF NOT EXISTS "refund_status" varchar(20),
                ADD COLUMN IF NOT EXISTS "refund_amount" numeric(14,2),
                ADD COLUMN IF NOT EXISTS "refund_method" varchar(40),
                ADD COLUMN IF NOT EXISTS "refund_transaction_reference" varchar(180),
                ADD COLUMN IF NOT EXISTS "refund_proof" jsonb,
                ADD COLUMN IF NOT EXISTS "refund_processed_by" varchar(255),
                ADD COLUMN IF NOT EXISTS "refund_processed_at" timestamptz,
                ADD COLUMN IF NOT EXISTS "resolved_by" varchar(255),
                ADD COLUMN IF NOT EXISTS "refund_failure_note" varchar(500),
                ADD COLUMN IF NOT EXISTS "refund_failure_by" varchar(255)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_order_delivery_issues_refund_status_created"
            ON "order_delivery_issues" ("refund_status", "created_at")
        `);
    }

    // Rollback chỉ gỡ cột và constraint do migration này thêm; không xóa issue hay hồ sơ refund gốc.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [failedRows] = (await queryRunner.query(`
            SELECT
                (SELECT COUNT(*) FROM "payment_attempts" WHERE "status" = 'REFUND_FAILED') +
                (SELECT COUNT(*) FROM "payment_attempts" WHERE "refund_failure_note" IS NOT NULL OR "refund_failure_by" IS NOT NULL) +
                (SELECT COUNT(*) FROM "order_return_requests" WHERE "status" = 'REFUND_FAILED' OR "refund_failure_note" IS NOT NULL OR "refund_failure_by" IS NOT NULL OR "shipment_failure_note" IS NOT NULL) +
                (SELECT COUNT(*) FROM "order_delivery_issues" WHERE "refund_status" IS NOT NULL OR "refund_failure_note" IS NOT NULL OR "refund_failure_by" IS NOT NULL OR "resolved_by" IS NOT NULL) AS count
        `)) as Array<{ count: string }>;
        if (Number(failedRows?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi dữ liệu audit hoàn tiền hoặc vận đơn đã được ghi; giữ nguyên schema để không mất lịch sử xử lý.',
            );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "idx_order_delivery_issues_refund_status_created"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "uq_order_return_active_order_shop"`,
        );
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_order_return_active_order_shop"
            ON "order_return_requests" ("order_id", "shop_id")
            WHERE "status" IN ('REQUESTED', 'AWAITING_SHIPMENT', 'IN_TRANSIT', 'SHIPMENT_FAILED', 'RECEIVED', 'REFUND_PENDING')
        `);
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "shipment_failure_note"`,
        );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP CONSTRAINT IF EXISTS "ck_payment_attempts_status"
        `);
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD CONSTRAINT "ck_payment_attempts_status"
                CHECK ("status" IN ('PENDING','PAID','FAILED','EXPIRED','REFUND_PENDING','REFUNDED'))
        `);
        for (const column of ['refund_failure_by', 'refund_failure_note']) {
            await queryRunner.query(
                `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "${column}"`,
            );
            await queryRunner.query(
                `ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "${column}"`,
            );
        }
        for (const column of [
            'refund_failure_note',
            'refund_failure_by',
            'refund_processed_at',
            'refund_processed_by',
            'resolved_by',
            'refund_proof',
            'refund_transaction_reference',
            'refund_method',
            'refund_amount',
            'refund_status',
        ]) {
            await queryRunner.query(
                `ALTER TABLE "order_delivery_issues" DROP COLUMN IF EXISTS "${column}"`,
            );
        }
    }
}
