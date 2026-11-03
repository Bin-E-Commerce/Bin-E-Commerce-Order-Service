import { MigrationInterface, QueryRunner } from 'typeorm';

// Khôi phục cột mã ngân hàng bị thiếu dù migration thêm tài khoản hoàn đã được ghi nhận.
export class RepairRefundBankCode1793008600000 implements MigrationInterface {
    name = 'RepairRefundBankCode1793008600000';

    // Thêm cột nullable để dữ liệu refund cũ tiếp tục đọc được và không cần backfill giả.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "refund_bank_code" varchar(50)
        `);
    }

    // Không gỡ cột sau khi mã ngân hàng đã được lưu vì đây là thông tin hoàn tiền cần tra cứu.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [rows] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "payment_attempts"
            WHERE "refund_bank_code" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(rows?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi mã ngân hàng nhận hoàn đã được ghi nhận; giữ nguyên dữ liệu xử lý refund.',
            );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP COLUMN IF EXISTS "refund_bank_code"
        `);
    }
}
