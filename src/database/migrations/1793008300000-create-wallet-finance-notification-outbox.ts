// Tạo outbox bền vững để event tài chính không mất giữa commit ví và publish Kafka.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWalletFinanceNotificationOutbox1793008300000
    implements MigrationInterface
{
    name = 'CreateWalletFinanceNotificationOutbox1793008300000';

    // Lưu event envelope và lịch retry riêng khỏi ledger để worker có thể gửi lại an toàn.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "wallet_finance_notification_outbox" (
                "event_id" character varying(255) NOT NULL,
                "topic" character varying(128) NOT NULL,
                "aggregate_id" uuid NOT NULL,
                "payload" jsonb NOT NULL,
                "status" character varying(16) NOT NULL DEFAULT 'PENDING',
                "attempt_count" integer NOT NULL DEFAULT 0,
                "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "published_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "pk_wallet_finance_notification_outbox" PRIMARY KEY ("event_id"),
                CONSTRAINT "chk_wallet_finance_notification_outbox_status"
                    CHECK ("status" IN ('PENDING', 'PROCESSING', 'PUBLISHED'))
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_wallet_finance_notification_outbox_pending"
            ON "wallet_finance_notification_outbox" ("status", "available_at", "created_at")
        `);
    }

    // Gỡ index và bảng khi rollback migration.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'DROP INDEX "idx_wallet_finance_notification_outbox_pending"',
        );
        await queryRunner.query(
            'DROP TABLE "wallet_finance_notification_outbox"',
        );
    }
}
