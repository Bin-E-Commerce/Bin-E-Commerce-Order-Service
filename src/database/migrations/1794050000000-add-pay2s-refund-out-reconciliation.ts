// Lưu giao dịch OUT Pay2S đã khớp khoản hoàn để admin đối chiếu và không tạo lại QR.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Candidate webhook chỉ là bằng chứng giao dịch tiền ra, không tự xác nhận người thụ hưởng hoặc hoàn tất refund.
export class AddPay2sRefundOutReconciliation1794050000000 implements MigrationInterface {
    name = 'AddPay2sRefundOutReconciliation1794050000000';

    // Các cột nullable giữ nguyên dữ liệu cũ; unique index ngăn một Pay2S OUT bị gắn vào nhiều khoản hoàn.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "refund_out_transaction_id" varchar(120),
                ADD COLUMN IF NOT EXISTS "refund_out_transaction_number" varchar(120),
                ADD COLUMN IF NOT EXISTS "refund_out_amount" numeric(14,2),
                ADD COLUMN IF NOT EXISTS "refund_out_detected_at" timestamptz
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_attempts_refund_out_transaction_id"
            ON "payment_attempts" ("refund_out_transaction_id")
            WHERE "refund_out_transaction_id" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_payment_attempts_refund_transfer_code_pending"
            ON "payment_attempts" (UPPER(LEFT(REPLACE("id"::text, '-', ''), 18)))
            WHERE "status" IN ('REFUND_PENDING', 'REFUND_FAILED')
        `);
    }

    // Không cho rollback xóa candidate webhook đã thành bằng chứng audit tài chính.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "payment_attempts"
            WHERE "refund_out_transaction_id" IS NOT NULL
               OR "refund_out_transaction_number" IS NOT NULL
               OR "refund_out_amount" IS NOT NULL
               OR "refund_out_detected_at" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi giao dịch OUT hoàn tiền đã được lưu; giữ lại bằng chứng đối soát.',
            );

        await queryRunner.query(
            `DROP INDEX IF EXISTS "uq_payment_attempts_refund_out_transaction_id"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "idx_payment_attempts_refund_transfer_code_pending"`,
        );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP COLUMN IF EXISTS "refund_out_detected_at",
                DROP COLUMN IF EXISTS "refund_out_amount",
                DROP COLUMN IF EXISTS "refund_out_transaction_number",
                DROP COLUMN IF EXISTS "refund_out_transaction_id"
        `);
    }
}
