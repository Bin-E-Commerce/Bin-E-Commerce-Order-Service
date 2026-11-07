import { MigrationInterface, QueryRunner } from 'typeorm';

// Liên kết payment attempt với hồ sơ ngân hàng để các lần sửa sau cập nhật đúng refund chưa xử lý.
export class LinkRefundBankAccountProfile1794032726000 implements MigrationInterface {
    name = 'LinkRefundBankAccountProfile1794032726000';

    // Cột nullable giữ tương thích đơn cũ; snapshot legacy được liên kết khi profile cập nhật khớp dữ liệu cũ.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                ADD COLUMN IF NOT EXISTS "refund_bank_account_id" uuid
        `);
    }

    // Không rollback nếu attempt đã dùng account ID để tránh mất liên kết cần cho refund đang xử lý.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [rows] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "payment_attempts"
            WHERE "refund_bank_account_id" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(rows?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi payment attempt đã liên kết hồ sơ ngân hàng nhận hoàn.',
            );
        await queryRunner.query(`
            ALTER TABLE "payment_attempts"
                DROP COLUMN IF EXISTS "refund_bank_account_id"
        `);
    }
}
