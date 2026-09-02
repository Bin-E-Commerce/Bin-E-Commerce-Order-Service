// Migration bổ sung tiền sản phẩm riêng và chuẩn hóa các khoản hoàn tiền về đồng VND.
import { MigrationInterface, QueryRunner } from "typeorm";

export class NormalizeReturnMoney1788012000000 implements MigrationInterface {
  name = "NormalizeReturnMoney1788012000000";

  // Backfill từ snapshot order_items để request cũ có thể hiển thị đúng từng khoản tiền.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "refund_item_amount" numeric(14,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      WITH item_totals AS (
        SELECT
          request.id,
          COALESCE(SUM(item.line_total), 0) AS item_amount,
          COUNT(item.id) AS item_count
        FROM order_return_requests request
        LEFT JOIN order_items item
          ON item.order_id = request.order_id
         AND item.id::text IN (
           SELECT jsonb_array_elements_text(request.item_ids)
         )
        GROUP BY request.id
      )
      UPDATE order_return_requests request
      SET
        refund_item_amount = ROUND(
          CASE
            WHEN item_totals.item_count > 0 THEN item_totals.item_amount
            ELSE GREATEST(request.refund_amount - request.refund_shipping_amount, 0)
          END
        ),
        refund_shipping_amount = ROUND(request.refund_shipping_amount),
        return_shipping_fee = ROUND(request.return_shipping_fee)
      FROM item_totals
      WHERE request.id = item_totals.id
    `);
    await queryRunner.query(`
      UPDATE order_return_requests
      SET refund_amount = refund_item_amount + refund_shipping_amount - return_shipping_fee
    `);
  }

  // Rollback chỉ bỏ cột mới; dữ liệu các cột tiền cũ vẫn được giữ nguyên.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "refund_item_amount"`);
  }
}
