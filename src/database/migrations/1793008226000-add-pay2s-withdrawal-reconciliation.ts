import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu giao dịch Pay2S OUT chờ admin xác minh người nhận trước khi tất toán ví seller.
export class AddPay2sWithdrawalReconciliation1793008226000 implements MigrationInterface {
    name = 'AddPay2sWithdrawalReconciliation1793008226000';

    // Candidate event được lưu bền vững để webhook retry không mất trạng thái và ID không thể gán cho hai yêu cầu.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "wallet_withdrawal_requests"
                ADD COLUMN "pay2s_transaction_id" varchar(120),
                ADD COLUMN "pay2s_transaction_number" varchar(120),
                ADD COLUMN "pay2s_transfer_amount" numeric(14,2),
                ADD COLUMN "pay2s_transfer_detected_at" timestamptz,
                ADD COLUMN "recipient_confirmed_by" varchar(255),
                ADD COLUMN "recipient_confirmed_at" timestamptz
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_wallet_withdrawals_pay2s_transaction_id"
            ON "wallet_withdrawal_requests" ("pay2s_transaction_id")
            WHERE "pay2s_transaction_id" IS NOT NULL
        `);
    }

    // Chỉ rollback khi chưa có event hoặc xác nhận người nhận để không xóa audit tài chính đã phát sinh.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [{ count }] = await queryRunner.query(`
            SELECT COUNT(*) AS count
            FROM "wallet_withdrawal_requests"
            WHERE "pay2s_transaction_id" IS NOT NULL
               OR "recipient_confirmed_by" IS NOT NULL
        `);
        if (Number(count) > 0)
            throw new Error(
                'Không thể rollback khi yêu cầu rút đã có giao dịch Pay2S hoặc xác nhận người nhận.',
            );

        await queryRunner.query(
            `DROP INDEX "uq_wallet_withdrawals_pay2s_transaction_id"`,
        );
        await queryRunner.query(`
            ALTER TABLE "wallet_withdrawal_requests"
                DROP COLUMN "recipient_confirmed_at",
                DROP COLUMN "recipient_confirmed_by",
                DROP COLUMN "pay2s_transfer_detected_at",
                DROP COLUMN "pay2s_transfer_amount",
                DROP COLUMN "pay2s_transaction_number",
                DROP COLUMN "pay2s_transaction_id"
        `);
    }
}
