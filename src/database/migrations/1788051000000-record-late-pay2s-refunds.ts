import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu audit hoàn thủ công cho Pay2S IPN đến sau khi order đã bị hủy; case này không có return request.
export class RecordLatePay2sRefunds1788051000000 implements MigrationInterface {
    name = 'RecordLatePay2sRefunds1788051000000';

    // Bổ sung bằng chứng refund ngay trên PaymentAttempt để admin có thể xử lý late payment độc lập với return flow.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "refund_transaction_reference" varchar(180)`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "refund_proof" jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "refund_processed_by" varchar(255)`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "refund_processed_at" timestamptz`,
        );
    }

    // Rollback chỉ bỏ metadata refund mới, không xóa attempt hoặc ledger giao dịch đã phát sinh.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "refund_processed_at"`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "refund_processed_by"`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "refund_proof"`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "refund_transaction_reference"`,
        );
    }
}
