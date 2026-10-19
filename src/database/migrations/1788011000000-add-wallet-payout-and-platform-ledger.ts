// Migration mở rộng ví seller và sổ tiền nền tảng demo; không backfill giao dịch cũ thành tiền thật.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalletPayoutAndPlatformLedger1788011000000 implements MigrationInterface {
    name = 'AddWalletPayoutAndPlatformLedger1788011000000';

    // Thêm ledger idempotent, giao dịch nạp Sandbox, yêu cầu payout và đợt đối soát nội bộ.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "seller_wallets" ADD COLUMN IF NOT EXISTS "reserved_balance" numeric(14,2) NOT NULL DEFAULT 0`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" ALTER COLUMN "order_id" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" DROP CONSTRAINT IF EXISTS "ck_seller_wallet_ledger_kind"`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" ADD CONSTRAINT "ck_seller_wallet_ledger_kind" CHECK ("kind" IN ('SALE_PENDING','RELEASE_AVAILABLE','REFUND_PENDING_REVERSAL','REFUND_AVAILABLE_REVERSAL','WALLET_DEPOSIT','WITHDRAWAL_RESERVED','WITHDRAWAL_PAID','WITHDRAWAL_RELEASED','RETURN_SHIPPING_DEBIT'))`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallets" ADD CONSTRAINT "ck_seller_wallet_reserved_nonnegative" CHECK ("reserved_balance" >= 0)`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "return_shipping_payer" varchar(16)`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "return_shipping_finalized_at" timestamptz`,
        );
        await queryRunner.query(`
            CREATE TABLE "wallet_deposits" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "shop_id" uuid NOT NULL,
                "seller_user_id" varchar(255) NOT NULL,
                "merchant_reference" varchar(64) NOT NULL,
                "provider_transaction_id" varchar(64),
                "status" varchar(20) NOT NULL DEFAULT 'PENDING',
                "environment" varchar(20) NOT NULL DEFAULT 'SANDBOX',
                "amount" numeric(14,2) NOT NULL,
                "expires_at" timestamptz NOT NULL,
                "provider_response" jsonb,
                "confirmed_at" timestamptz,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_wallet_deposits_id" PRIMARY KEY ("id"),
                CONSTRAINT "uq_wallet_deposits_merchant_reference" UNIQUE ("merchant_reference"),
                CONSTRAINT "ck_wallet_deposits_status" CHECK ("status" IN ('PENDING','PAID','FAILED','EXPIRED')),
                CONSTRAINT "ck_wallet_deposits_environment" CHECK ("environment" = 'SANDBOX'),
                CONSTRAINT "ck_wallet_deposits_amount" CHECK ("amount" > 0)
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_wallet_deposits_provider_transaction" ON "wallet_deposits" ("provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wallet_deposits_shop_created" ON "wallet_deposits" ("shop_id", "created_at" DESC)`,
        );
        await queryRunner.query(`
            CREATE TABLE "wallet_withdrawal_requests" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "shop_id" uuid NOT NULL,
                "seller_user_id" varchar(255) NOT NULL,
                "amount" numeric(14,2) NOT NULL,
                "bank_code" varchar(40) NOT NULL,
                "bank_name" varchar(120) NOT NULL,
                "account_holder" varchar(160) NOT NULL,
                "account_number" varchar(40) NOT NULL,
                "account_number_masked" varchar(40) NOT NULL,
                "status" varchar(24) NOT NULL DEFAULT 'REQUESTED',
                "transfer_reference" varchar(120),
                "admin_note" varchar(500),
                "processed_by" varchar(255),
                "processed_at" timestamptz,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_wallet_withdrawal_requests_id" PRIMARY KEY ("id"),
                CONSTRAINT "ck_wallet_withdrawal_requests_status" CHECK ("status" IN ('REQUESTED','PROCESSING','PAID','REJECTED','FAILED')),
                CONSTRAINT "ck_wallet_withdrawal_requests_amount" CHECK ("amount" > 0)
            )
        `);
        await queryRunner.query(
            `CREATE INDEX "idx_wallet_withdrawals_shop_created" ON "wallet_withdrawal_requests" ("shop_id", "created_at" DESC)`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wallet_withdrawals_status_created" ON "wallet_withdrawal_requests" ("status", "created_at" ASC)`,
        );
        await queryRunner.query(`
            CREATE TABLE "platform_finance_ledger" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "kind" varchar(40) NOT NULL,
                "amount" numeric(14,2) NOT NULL,
                "source_key" varchar(180) NOT NULL,
                "shop_id" uuid,
                "order_id" uuid,
                "return_request_id" uuid,
                "reference" varchar(120),
                "settlement_batch_id" uuid,
                "created_by" varchar(255),
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_platform_finance_ledger_id" PRIMARY KEY ("id"),
                CONSTRAINT "uq_platform_finance_ledger_source_key" UNIQUE ("source_key"),
                CONSTRAINT "ck_platform_finance_ledger_kind" CHECK ("kind" IN ('ORDER_PAYMENT','WALLET_DEPOSIT','COD_REMITTANCE','VNPAY_REFUND','COD_REFUND','SELLER_PAYOUT','RETURN_SHIPPING_FEE','CUSTOMER_RETURN_SHIPPING_RECEIVABLE'))
            )
        `);
        await queryRunner.query(
            `CREATE INDEX "idx_platform_finance_ledger_created" ON "platform_finance_ledger" ("created_at" DESC)`,
        );
        await queryRunner.query(`CREATE TABLE "finance_settlement_batches" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "status" varchar(32) NOT NULL DEFAULT 'OPEN',
            "note" varchar(500),
            "created_by" varchar(255) NOT NULL,
            "reconciled_by" varchar(255),
            "reconciled_at" timestamptz,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "pk_finance_settlement_batches_id" PRIMARY KEY ("id"),
            CONSTRAINT "ck_finance_settlement_batches_status" CHECK ("status" IN ('OPEN','RECONCILED'))
        )`);
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" ADD CONSTRAINT "fk_platform_finance_settlement_batch" FOREIGN KEY ("settlement_batch_id") REFERENCES "finance_settlement_batches"("id") ON DELETE SET NULL`,
        );
    }

    // Rollback chỉ xóa cấu trúc mới khi chưa có dữ liệu để tránh mất sổ ví hoặc audit.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [{ count }] = await queryRunner.query(`
            SELECT
                (SELECT COUNT(*) FROM "wallet_deposits") +
                (SELECT COUNT(*) FROM "wallet_withdrawal_requests") +
                (SELECT COUNT(*) FROM "platform_finance_ledger") +
                (SELECT COUNT(*) FROM "seller_wallet_ledger"
                 WHERE "kind" IN ('WALLET_DEPOSIT','WITHDRAWAL_RESERVED','WITHDRAWAL_PAID','WITHDRAWAL_RELEASED','RETURN_SHIPPING_DEBIT')) +
                (SELECT COUNT(*) FROM "order_return_requests"
                 WHERE "return_shipping_payer" IS NOT NULL OR "return_shipping_finalized_at" IS NOT NULL) AS count
        `);
        if (Number(count) > 0)
            throw new Error(
                'Không thể rollback khi đã có giao dịch ví hoặc sổ tiền nền tảng.',
            );
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" DROP CONSTRAINT "fk_platform_finance_settlement_batch"`,
        );
        await queryRunner.query(`DROP TABLE "finance_settlement_batches"`);
        await queryRunner.query(
            `DROP INDEX "idx_platform_finance_ledger_created"`,
        );
        await queryRunner.query(`DROP TABLE "platform_finance_ledger"`);
        await queryRunner.query(
            `DROP INDEX "idx_wallet_withdrawals_status_created"`,
        );
        await queryRunner.query(
            `DROP INDEX "idx_wallet_withdrawals_shop_created"`,
        );
        await queryRunner.query(`DROP TABLE "wallet_withdrawal_requests"`);
        await queryRunner.query(
            `DROP INDEX "idx_wallet_deposits_shop_created"`,
        );
        await queryRunner.query(
            `DROP INDEX "uq_wallet_deposits_provider_transaction"`,
        );
        await queryRunner.query(`DROP TABLE "wallet_deposits"`);
        await queryRunner.query(
            `ALTER TABLE "seller_wallets" DROP CONSTRAINT "ck_seller_wallet_reserved_nonnegative"`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallets" DROP COLUMN "reserved_balance"`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "return_shipping_finalized_at"`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "return_shipping_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" DROP CONSTRAINT "ck_seller_wallet_ledger_kind"`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" ADD CONSTRAINT "ck_seller_wallet_ledger_kind" CHECK ("kind" IN ('SALE_PENDING','RELEASE_AVAILABLE','REFUND_PENDING_REVERSAL','REFUND_AVAILABLE_REVERSAL'))`,
        );
        await queryRunner.query(
            `ALTER TABLE "seller_wallet_ledger" ALTER COLUMN "order_id" SET NOT NULL`,
        );
    }
}
