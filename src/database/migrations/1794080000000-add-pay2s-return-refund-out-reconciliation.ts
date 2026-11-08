// Lưu giao dịch OUT Pay2S khớp return để admin đối chiếu trước khi chốt hoàn.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Candidate là bằng chứng tiền ra.
// Migration không tự xác nhận người nhận hoặc hoàn tất refund.
export class AddPay2sReturnRefundOutReconciliation1794080000000
    implements MigrationInterface
{
    name = 'AddPay2sReturnRefundOutReconciliation1794080000000';

    // Cột nullable giữ nguyên return cũ; index duy nhất chống gắn một event hai lần.
    // Prefix index giới hạn tra cứu theo mã ngắn trong webhook.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ADD COLUMN IF NOT EXISTS "refund_out_transaction_id" varchar(120),
                ADD COLUMN IF NOT EXISTS "refund_out_transaction_number" varchar(120),
                ADD COLUMN IF NOT EXISTS "refund_out_amount" numeric(14,2),
                ADD COLUMN IF NOT EXISTS "refund_out_detected_at" timestamptz
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_order_return_requests_refund_out_transaction_id"
            ON "order_return_requests" ("refund_out_transaction_id")
            WHERE "refund_out_transaction_id" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_order_return_requests_refund_transfer_code_pending"
            ON "order_return_requests" (UPPER(LEFT(REPLACE("id"::text, '-', ''), 18)))
            WHERE "status" IN ('REFUND_PENDING', 'REFUND_FAILED')
        `);
    }

    // Không cho rollback xóa candidate webhook đã ghi làm bằng chứng tài chính.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "order_return_requests"
            WHERE "refund_out_transaction_id" IS NOT NULL
               OR "refund_out_transaction_number" IS NOT NULL
               OR "refund_out_amount" IS NOT NULL
               OR "refund_out_detected_at" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0) {
            throw new Error(
                'Không thể rollback khi giao dịch OUT return đã được lưu; giữ lại bằng chứng đối soát.',
            );
        }

        await queryRunner.query(
            `DROP INDEX IF EXISTS "uq_order_return_requests_refund_out_transaction_id"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "idx_order_return_requests_refund_transfer_code_pending"`,
        );
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                DROP COLUMN IF EXISTS "refund_out_detected_at",
                DROP COLUMN IF EXISTS "refund_out_amount",
                DROP COLUMN IF EXISTS "refund_out_transaction_number",
                DROP COLUMN IF EXISTS "refund_out_transaction_id"
        `);
    }
}
