// Tách ID dòng lịch sử Pay2S khỏi IPN transId và mã giao dịch ngân hàng.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPay2sHistoryIdentifiers1794100000000 implements MigrationInterface {
    name = 'AddPay2sHistoryIdentifiers1794100000000';

    // Các cột nullable giữ nguyên attempt cũ; unique history ID ngăn cron tạo hồ sơ lặp.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "pay2s_history_id" varchar(64),
                ADD COLUMN IF NOT EXISTS "pay2s_bank_transaction_id" varchar(120),
                ADD COLUMN IF NOT EXISTS "pay2s_history_checksum" varchar(64)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_attempts_pay2s_history_id"
            ON "payment_attempts" ("pay2s_history_id")
            WHERE "pay2s_history_id" IS NOT NULL
        `);
    }

    // Không rollback nếu đã có giao dịch history; các định danh này là bằng chứng đối soát tài chính.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "payment_attempts"
            WHERE "pay2s_history_id" IS NOT NULL
               OR "pay2s_bank_transaction_id" IS NOT NULL
               OR "pay2s_history_checksum" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi ID lịch sử Pay2S đã được ghi; giữ lại bằng chứng đối soát.',
            );

        await queryRunner.query(
            'DROP INDEX IF EXISTS "uq_payment_attempts_pay2s_history_id"',
        );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP COLUMN IF EXISTS "pay2s_history_checksum",
                DROP COLUMN IF EXISTS "pay2s_bank_transaction_id",
                DROP COLUMN IF EXISTS "pay2s_history_id"
        `);
    }
}
