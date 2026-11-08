import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu snapshot tài khoản Customer chọn để Admin hoàn đúng người nhận cho yêu cầu return sau giao hàng.
export class AddReturnRefundBankAccount1794070000000 implements MigrationInterface {
    name = 'AddReturnRefundBankAccount1794070000000';

    // Cột nullable giữ tương thích các yêu cầu return cũ; service bắt buộc snapshot cho request mới.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ADD COLUMN IF NOT EXISTS "refund_bank_account_id" uuid,
                ADD COLUMN IF NOT EXISTS "refund_bank_code" varchar(50),
                ADD COLUMN IF NOT EXISTS "refund_bank_name" varchar(100),
                ADD COLUMN IF NOT EXISTS "refund_account_holder" varchar(100),
                ADD COLUMN IF NOT EXISTS "refund_account_number" varchar(30)
        `);
    }

    // Không cho rollback làm mất thông tin nhận hoàn của request đã phát sinh.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "order_return_requests"
            WHERE "refund_bank_account_id" IS NOT NULL
               OR "refund_bank_code" IS NOT NULL
               OR "refund_bank_name" IS NOT NULL
               OR "refund_account_holder" IS NOT NULL
               OR "refund_account_number" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0) {
            throw new Error(
                'Không thể rollback khi yêu cầu hoàn hàng đã lưu tài khoản nhận tiền.',
            );
        }

        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                DROP COLUMN IF EXISTS "refund_account_number",
                DROP COLUMN IF EXISTS "refund_account_holder",
                DROP COLUMN IF EXISTS "refund_bank_name",
                DROP COLUMN IF EXISTS "refund_bank_code",
                DROP COLUMN IF EXISTS "refund_bank_account_id"
        `);
    }
}
