import { MigrationInterface, QueryRunner } from 'typeorm';

// Chuyển provider thanh toán sang Pay2S mà không xóa attempt, ledger hoặc bằng chứng callback cũ.
export class MigrateVnpayToPay2s1788050000000 implements MigrationInterface {
    name = 'MigrateVnpayToPay2s1788050000000';

    // Mở rộng schema trước, sau đó đổi dữ liệu và constraint để code mới chỉ còn nhận PAY2S.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "payment_method_enum" RENAME VALUE 'VNPAY' TO 'PAY2S'`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "provider_request_id" varchar(80)`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "provider_order_info" varchar(180)`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" ADD COLUMN IF NOT EXISTS "provider_request_id" varchar(80)`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" ADD COLUMN IF NOT EXISTS "provider_order_info" varchar(180)`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ALTER COLUMN "provider_create_date" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" DROP CONSTRAINT IF EXISTS "ck_wallet_deposits_environment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" ADD CONSTRAINT "ck_wallet_deposits_environment" CHECK ("environment" IN ('SANDBOX','LIVE'))`,
        );
        await queryRunner.query(
            `UPDATE "order_return_requests" SET "refund_method" = 'PAY2S_MANUAL' WHERE "refund_method" = 'VNPAY'`,
        );
        await queryRunner.query(
            `UPDATE "platform_finance_ledger" SET "kind" = 'PAY2S_REFUND_MANUAL' WHERE "kind" = 'VNPAY_REFUND'`,
        );
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" DROP CONSTRAINT IF EXISTS "ck_platform_finance_ledger_kind"`,
        );
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" ADD CONSTRAINT "ck_platform_finance_ledger_kind" CHECK ("kind" IN ('ORDER_PAYMENT','WALLET_DEPOSIT','COD_REMITTANCE','PAY2S_REFUND_MANUAL','COD_REFUND','SELLER_PAYOUT','RETURN_SHIPPING_FEE','CUSTOMER_RETURN_SHIPPING_RECEIVABLE'))`,
        );
    }

    // Rollback giữ dữ liệu giao dịch, chỉ đổi tên provider và khôi phục schema cũ.
    async down(queryRunner: QueryRunner): Promise<void> {
        // Schema cũ chỉ cho SANDBOX; dừng trước mọi thay đổi để tránh rollback nửa chừng khi đã có nạp LIVE.
        const liveDeposits = (await queryRunner.query(
            `SELECT COUNT(*)::int AS count FROM "wallet_deposits" WHERE "environment" = 'LIVE'`,
        )) as Array<{ count: number }>;
        if ((liveDeposits[0]?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback Pay2S khi wallet_deposits còn giao dịch LIVE; cần xử lý dữ liệu LIVE trước.',
            );

        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" DROP CONSTRAINT IF EXISTS "ck_platform_finance_ledger_kind"`,
        );
        await queryRunner.query(
            `UPDATE "platform_finance_ledger" SET "kind" = 'VNPAY_REFUND' WHERE "kind" = 'PAY2S_REFUND_MANUAL'`,
        );
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" ADD CONSTRAINT "ck_platform_finance_ledger_kind" CHECK ("kind" IN ('ORDER_PAYMENT','WALLET_DEPOSIT','COD_REMITTANCE','VNPAY_REFUND','COD_REFUND','SELLER_PAYOUT','RETURN_SHIPPING_FEE','CUSTOMER_RETURN_SHIPPING_RECEIVABLE'))`,
        );
        await queryRunner.query(
            `UPDATE "order_return_requests" SET "refund_method" = 'VNPAY' WHERE "refund_method" = 'PAY2S_MANUAL'`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" DROP CONSTRAINT IF EXISTS "ck_wallet_deposits_environment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" ADD CONSTRAINT "ck_wallet_deposits_environment" CHECK ("environment" = 'SANDBOX')`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "provider_order_info"`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "provider_request_id"`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" DROP COLUMN IF EXISTS "provider_order_info"`,
        );
        await queryRunner.query(
            `ALTER TABLE "wallet_deposits" DROP COLUMN IF EXISTS "provider_request_id"`,
        );
        await queryRunner.query(
            `ALTER TABLE "payment_attempts" ALTER COLUMN "provider_create_date" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TYPE "payment_method_enum" RENAME VALUE 'PAY2S' TO 'VNPAY'`,
        );
    }
}
