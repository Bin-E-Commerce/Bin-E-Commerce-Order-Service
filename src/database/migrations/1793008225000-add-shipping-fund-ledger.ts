import { MigrationInterface, QueryRunner } from 'typeorm';

// Tách phần phí ship đã thu khỏi tiền mặt khả dụng và lưu dấu các khoản hoàn/chi quỹ.
export class AddShippingFundLedger1793008225000 implements MigrationInterface {
    name = 'AddShippingFundLedger1793008225000';

    // Mở rộng loại ledger rồi backfill các khoản đã thu/hoàn để số dư quỹ phản ánh cả lịch sử hiện có.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" DROP CONSTRAINT IF EXISTS "ck_platform_finance_ledger_kind"`,
        );
        await queryRunner.query(`
            ALTER TABLE "platform_finance_ledger"
            ADD CONSTRAINT "ck_platform_finance_ledger_kind"
            CHECK ("kind" IN (
                'ORDER_PAYMENT', 'WALLET_DEPOSIT', 'COD_REMITTANCE',
                'PAY2S_REFUND_MANUAL', 'COD_REFUND', 'SELLER_PAYOUT',
                'RETURN_SHIPPING_FEE', 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE',
                'SHIPPING_FUND_ALLOCATION', 'SHIPPING_FUND_REFUND'
            ))
        `);
        await queryRunner.query(`
            INSERT INTO "platform_finance_ledger"
                ("kind", "amount", "source_key", "shop_id", "order_id",
                 "return_request_id", "reference", "settlement_batch_id", "created_by")
            SELECT
                'SHIPPING_FUND_ALLOCATION', order_row."shipping_fee",
                'shipping-fund:allocation:' || order_row."id",
                NULL, order_row."id", NULL, order_row."order_number", NULL, NULL
            FROM "orders" order_row
            WHERE order_row."shipping_fee" > 0
              AND EXISTS (
                  SELECT 1 FROM "platform_finance_ledger" payment
                  WHERE payment."order_id" = order_row."id"
                    AND payment."kind" IN ('ORDER_PAYMENT', 'COD_REMITTANCE')
              )
            ON CONFLICT ("source_key") DO NOTHING
        `);
        await queryRunner.query(`
            INSERT INTO "platform_finance_ledger"
                ("kind", "amount", "source_key", "shop_id", "order_id",
                 "return_request_id", "reference", "settlement_batch_id", "created_by")
            SELECT
                'SHIPPING_FUND_REFUND', -request."refund_shipping_amount",
                'shipping-fund:refund:' || request."id",
                request."shop_id", request."order_id", request."id",
                request."refund_transaction_reference", NULL,
                request."refund_processed_by"
            FROM "order_return_requests" request
            WHERE request."refund_shipping_amount" > 0
              AND request."status" = 'REFUNDED'
              AND EXISTS (
                  SELECT 1 FROM "platform_finance_ledger" refund
                  WHERE refund."return_request_id" = request."id"
                    AND refund."kind" IN ('PAY2S_REFUND_MANUAL', 'COD_REFUND')
              )
            ON CONFLICT ("source_key") DO NOTHING
        `);
    }

    // Rollback xóa riêng các dòng phân bổ/hoàn được dựng từ phí ship; ledger tiền mặt gốc vẫn được giữ.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DELETE FROM "platform_finance_ledger" WHERE "kind" IN ('SHIPPING_FUND_ALLOCATION', 'SHIPPING_FUND_REFUND')`,
        );
        await queryRunner.query(
            `ALTER TABLE "platform_finance_ledger" DROP CONSTRAINT IF EXISTS "ck_platform_finance_ledger_kind"`,
        );
        await queryRunner.query(`
            ALTER TABLE "platform_finance_ledger"
            ADD CONSTRAINT "ck_platform_finance_ledger_kind"
            CHECK ("kind" IN (
                'ORDER_PAYMENT', 'WALLET_DEPOSIT', 'COD_REMITTANCE',
                'PAY2S_REFUND_MANUAL', 'COD_REFUND', 'SELLER_PAYOUT',
                'RETURN_SHIPPING_FEE', 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE'
            ))
        `);
    }
}
