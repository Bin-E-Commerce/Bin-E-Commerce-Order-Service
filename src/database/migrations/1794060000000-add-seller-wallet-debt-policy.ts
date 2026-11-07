import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu hạn trả nợ theo lần đầu ví âm và backfill hạn 3 ngày cho khoản nợ đã tồn tại.
export class AddSellerWalletDebtPolicy1794060000000 implements MigrationInterface {
    name = 'AddSellerWalletDebtPolicy1794060000000';

    // Trigger giữ hạn trả ổn định qua các lần trừ/nạp và xóa hạn khi ví đã được bù về không.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "seller_wallets"
                ADD COLUMN IF NOT EXISTS "debt_due_at" timestamptz,
                ADD COLUMN IF NOT EXISTS "finance_locked_at" timestamptz
        `);
        await queryRunner.query(`
            UPDATE "seller_wallets"
            SET "debt_due_at" = NOW() + INTERVAL '3 days'
            WHERE "available_balance" < 0 AND "debt_due_at" IS NULL
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION set_seller_wallet_debt_deadline()
            RETURNS trigger AS $$
            BEGIN
                IF NEW."available_balance" < 0 THEN
                    IF TG_OP = 'INSERT' THEN
                        NEW."debt_due_at" := NOW() + INTERVAL '3 days';
                    ELSIF OLD."available_balance" >= 0 OR NEW."debt_due_at" IS NULL THEN
                        NEW."debt_due_at" := NOW() + INTERVAL '3 days';
                    END IF;
                ELSE
                    NEW."debt_due_at" := NULL;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "trg_seller_wallet_debt_deadline" ON "seller_wallets"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "trg_seller_wallet_debt_deadline"
            BEFORE INSERT OR UPDATE OF "available_balance" ON "seller_wallets"
            FOR EACH ROW EXECUTE FUNCTION set_seller_wallet_debt_deadline()
        `);
    }

    // Giữ migration không thể rollback khi còn nợ hoặc khóa tài chính đang cần deadline để thực thi chính sách.
    async down(queryRunner: QueryRunner): Promise<void> {
        const [result] = (await queryRunner.query(`
            SELECT COUNT(*)::int AS count
            FROM "seller_wallets"
            WHERE "available_balance" < 0 OR "finance_locked_at" IS NOT NULL
        `)) as Array<{ count: number }>;
        if (Number(result?.count ?? 0) > 0)
            throw new Error(
                'Không thể rollback khi còn công nợ hoặc shop đang khóa vì công nợ.',
            );

        await queryRunner.query(
            `DROP TRIGGER IF EXISTS "trg_seller_wallet_debt_deadline" ON "seller_wallets"`,
        );
        await queryRunner.query(
            'DROP FUNCTION IF EXISTS set_seller_wallet_debt_deadline()',
        );
        await queryRunner.query(`
            ALTER TABLE "seller_wallets"
                DROP COLUMN IF EXISTS "finance_locked_at",
                DROP COLUMN IF EXISTS "debt_due_at"
        `);
    }
}
