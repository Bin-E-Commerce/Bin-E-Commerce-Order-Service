// Migration thêm payment attempt, metadata hoàn tiền và sổ ví; không thực hiện giao dịch tiền ngoài hệ thống.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Tạo cấu trúc tài chính có khóa idempotency để callback hoặc tác vụ chạy lại không nhân đôi số dư.
export class AddPaymentsAndSellerWallet1788008000000 implements MigrationInterface {
    name = 'AddPaymentsAndSellerWallet1788008000000';

    // Mở rộng schema có backfill an toàn; tất cả số dư mới bắt đầu bằng 0, không suy đoán đối soát lịch sử.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "payment_method_enum" ADD VALUE IF NOT EXISTS 'VNPAY'`,
        );
        await queryRunner.query(
            `ALTER TYPE "payment_status_enum" ADD VALUE IF NOT EXISTS 'PENDING'`,
        );
        await queryRunner.query(
            `ALTER TYPE "payment_status_enum" ADD VALUE IF NOT EXISTS 'FAILED'`,
        );
        await queryRunner.query(`
            ALTER TABLE "orders"
                ADD COLUMN "payment_expires_at" timestamptz,
                ADD COLUMN "is_sandbox" boolean NOT NULL DEFAULT false,
                ADD COLUMN "cod_remitted_at" timestamptz,
                ADD COLUMN "cod_remittance_reference" varchar(120),
                ADD COLUMN "cod_remittance_confirmed_by" varchar(255),
                ADD COLUMN "checkout_cart_item_id" uuid
        `);
        await queryRunner.query(`
            CREATE TABLE "payment_attempts" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "order_id" uuid NOT NULL,
                "merchant_reference" varchar(64) NOT NULL,
                "provider_transaction_id" varchar(64),
                "refund_request_id" varchar(32),
                "status" varchar(20) NOT NULL DEFAULT 'PENDING',
                "environment" varchar(20) NOT NULL DEFAULT 'LIVE',
                "amount" numeric(14,2) NOT NULL,
                "currency" char(3) NOT NULL DEFAULT 'VND',
                "expires_at" timestamptz NOT NULL,
                "provider_create_date" char(14) NOT NULL,
                "confirmed_at" timestamptz,
                "provider_response" jsonb,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_payment_attempts_id" PRIMARY KEY ("id"),
                CONSTRAINT "fk_payment_attempts_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
                CONSTRAINT "ck_payment_attempts_status" CHECK ("status" IN ('PENDING','PAID','FAILED','EXPIRED','REFUND_PENDING','REFUNDED')),
                CONSTRAINT "ck_payment_attempts_environment" CHECK ("environment" IN ('LIVE','SANDBOX'))
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_payment_attempts_merchant_reference" ON "payment_attempts" ("merchant_reference")`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_payment_attempts_pending_order" ON "payment_attempts" ("order_id") WHERE "status" = 'PENDING'`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_payment_attempts_provider_transaction" ON "payment_attempts" ("provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_payment_attempts_refund_request_id" ON "payment_attempts" ("refund_request_id") WHERE "refund_request_id" IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_payment_attempts_order_status" ON "payment_attempts" ("order_id", "status")`,
        );
        await queryRunner.query(`CREATE TABLE "seller_wallets" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "shop_id" uuid NOT NULL,
            "pending_balance" numeric(14,2) NOT NULL DEFAULT 0,
            "available_balance" numeric(14,2) NOT NULL DEFAULT 0,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "pk_seller_wallets_id" PRIMARY KEY ("id"),
            CONSTRAINT "uq_seller_wallets_shop_id" UNIQUE ("shop_id"),
            CONSTRAINT "ck_seller_wallet_pending_nonnegative" CHECK ("pending_balance" >= 0)
        )`);
        await queryRunner.query(`CREATE TABLE "seller_wallet_ledger" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "shop_id" uuid NOT NULL,
            "order_id" uuid NOT NULL,
            "return_request_id" uuid,
            "kind" varchar(32) NOT NULL,
            "amount" numeric(14,2) NOT NULL,
            "source_key" varchar(160) NOT NULL,
            "available_at" timestamptz,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "pk_seller_wallet_ledger_id" PRIMARY KEY ("id"),
            CONSTRAINT "uq_seller_wallet_ledger_source_key" UNIQUE ("source_key"),
            CONSTRAINT "ck_seller_wallet_ledger_kind" CHECK ("kind" IN ('SALE_PENDING','RELEASE_AVAILABLE','REFUND_PENDING_REVERSAL','REFUND_AVAILABLE_REVERSAL'))
        )`);
        await queryRunner.query(
            `CREATE INDEX "idx_seller_wallet_ledger_shop_created" ON "seller_wallet_ledger" ("shop_id", "created_at" DESC)`,
        );
        // Migration ExpandOrderReturns có thể đã thêm một phần metadata return ở production.
        // IF NOT EXISTS xử lý cột trùng; các ALTER tiếp theo đưa kiểu dữ liệu về cùng contract entity.
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ADD COLUMN IF NOT EXISTS "refund_method" varchar(40),
                ADD COLUMN IF NOT EXISTS "refund_request_id" varchar(32),
                ADD COLUMN IF NOT EXISTS "refund_transaction_reference" varchar(180),
                ADD COLUMN IF NOT EXISTS "refund_proof" jsonb,
                ADD COLUMN IF NOT EXISTS "refund_processed_by" varchar(255),
                ADD COLUMN IF NOT EXISTS "refund_processed_at" timestamptz
        `);
        // Các cột từ migration cũ có độ dài/nullable khác nhau; chuẩn hóa mà không xóa dữ liệu đã ghi.
        await queryRunner.query(`
            ALTER TABLE "order_return_requests"
                ALTER COLUMN "refund_method" TYPE varchar(40),
                ALTER COLUMN "refund_transaction_reference" TYPE varchar(180),
                ALTER COLUMN "refund_proof" DROP NOT NULL,
                ALTER COLUMN "refund_proof" DROP DEFAULT,
                ALTER COLUMN "refund_processed_by" TYPE varchar(255)
                    USING "refund_processed_by"::text
        `);
        // Cột này chỉ có ở migration thanh toán; index IF NOT EXISTS cho phép chạy cùng schema đã mở rộng.
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "uq_order_return_refund_request_id" ON "order_return_requests" ("refund_request_id") WHERE "refund_request_id" IS NOT NULL`,
        );
    }

    // Xóa dữ liệu mới chỉ khi không còn payment VNPay; enum PostgreSQL được giữ nguyên để tránh phá schema khác.
    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ count }] = await queryRunner.query(
            `SELECT COUNT(*)::int AS count FROM "orders" WHERE "payment_method"::text = 'VNPAY'`,
        );
        if (Number(count) > 0) {
            throw new Error('Không thể rollback khi đã có order VNPay.');
        }
        await queryRunner.query(
            `DROP INDEX IF EXISTS "uq_order_return_refund_request_id"`,
        );
        // Giữ các cột metadata được chia sẻ với migration return để rollback không phá schema của migration còn lại.
        await queryRunner.query(
            `ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "refund_request_id"`,
        );
        await queryRunner.query(
            `DROP INDEX "idx_seller_wallet_ledger_shop_created"`,
        );
        await queryRunner.query(`DROP TABLE "seller_wallet_ledger"`);
        await queryRunner.query(`DROP TABLE "seller_wallets"`);
        await queryRunner.query(
            `DROP INDEX "idx_payment_attempts_order_status"`,
        );
        await queryRunner.query(
            `DROP INDEX "uq_payment_attempts_provider_transaction"`,
        );
        await queryRunner.query(
            `DROP INDEX "uq_payment_attempts_refund_request_id"`,
        );
        await queryRunner.query(
            `DROP INDEX "uq_payment_attempts_pending_order"`,
        );
        await queryRunner.query(
            `DROP INDEX "uq_payment_attempts_merchant_reference"`,
        );
        await queryRunner.query(`DROP TABLE "payment_attempts"`);
        await queryRunner.query(
            `ALTER TABLE "orders" DROP COLUMN "checkout_cart_item_id", DROP COLUMN "cod_remittance_confirmed_by", DROP COLUMN "cod_remittance_reference", DROP COLUMN "cod_remitted_at", DROP COLUMN "is_sandbox", DROP COLUMN "payment_expires_at"`,
        );
    }
}
