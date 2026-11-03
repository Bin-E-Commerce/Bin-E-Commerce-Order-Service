import { MigrationInterface, QueryRunner } from 'typeorm';

// Gắn tài khoản nhận hoàn vào payment attempt để admin tra cứu đúng giao dịch đã thu tiền.
export class AddRefundBankAccount1793008500000 implements MigrationInterface {
    name = 'AddRefundBankAccount1793008500000';

    // Các cột nullable giữ tương thích với refund cũ và đơn chưa có tài khoản nhận hoàn.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "refund_bank_code" varchar(50),
                ADD COLUMN IF NOT EXISTS "refund_bank_name" varchar(100),
                ADD COLUMN IF NOT EXISTS "refund_account_holder" varchar(100),
                ADD COLUMN IF NOT EXISTS "refund_account_number" varchar(30)
        `);
    }

    // Không rollback nếu thông tin người nhận đã được lưu để tránh xóa dữ liệu refund đang cần xử lý.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [rows] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "payment_attempts"
            WHERE "refund_bank_name" IS NOT NULL
               OR "refund_bank_code" IS NOT NULL
               OR "refund_account_holder" IS NOT NULL
               OR "refund_account_number" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(rows?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi tài khoản nhận hoàn đã được ghi nhận; giữ nguyên schema để không mất dữ liệu xử lý refund.',
            );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP COLUMN IF EXISTS "refund_account_number",
                DROP COLUMN IF EXISTS "refund_account_holder",
                DROP COLUMN IF EXISTS "refund_bank_name",
                DROP COLUMN IF EXISTS "refund_bank_code"
        `);
    }
}
