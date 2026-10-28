import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu memo VietQR ngắn cho yêu cầu mới và yêu cầu REQUESTED chưa bắt đầu chuyển; payout đang xử lý giữ nguyên mã cũ.
export class AddVietQrWithdrawalMemoCode1793008227000 implements MigrationInterface {
    name = 'AddVietQrWithdrawalMemoCode1793008227000';

    // Chỉ REQUESTED được đổi memo vì admin chưa bắt đầu chuyển; PROCESSING giữ UUID để không lệch giao dịch có thể đã gửi.
    // Unique index ngăn mã QR ngắn trỏ tới nhiều payout; các mã cũ vẫn được parser nhận trực tiếp từ UUID.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "wallet_withdrawal_requests"
            ADD COLUMN "transfer_memo_code" varchar(23)
        `);
        await queryRunner.query(`
            UPDATE "wallet_withdrawal_requests"
            SET "transfer_memo_code" = 'RUT' || SUBSTRING(
                UPPER(REPLACE("id"::text, '-', '')) FROM 1 FOR 20
            )
            WHERE "status" = 'REQUESTED'
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_wallet_withdrawals_transfer_memo_code"
            ON "wallet_withdrawal_requests" ("transfer_memo_code")
            WHERE "transfer_memo_code" IS NOT NULL
        `);
    }

    // Giữ migration không thể rollback sau khi đã tạo mã cho yêu cầu mới, tránh làm mất khóa đối soát đã gửi cho admin.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [{ count }] = await queryRunner.query(`
            SELECT COUNT(*) AS count
            FROM "wallet_withdrawal_requests"
            WHERE "transfer_memo_code" IS NOT NULL
        `);
        if (Number(count) > 0)
            throw new Error(
                'Không thể rollback khi mã memo VietQR đã gắn với yêu cầu rút.',
            );

        await queryRunner.query(
            `DROP INDEX "uq_wallet_withdrawals_transfer_memo_code"`,
        );
        await queryRunner.query(`
            ALTER TABLE "wallet_withdrawal_requests"
            DROP COLUMN "transfer_memo_code"
        `);
    }
}
