// Migration lưu chi phí vận chuyển chiều ngược thực tế do Shipping Service lấy từ GHN.
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReturnShippingCost1788013000000 implements MigrationInterface {
  name = "AddReturnShippingCost1788013000000";

  // Chi phí thực tế và phần khách chịu được tách riêng để không làm sai số tiền hoàn.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_return_requests" ADD COLUMN IF NOT EXISTS "return_shipping_cost" numeric(14,2) NOT NULL DEFAULT 0`);
  }

  // Rollback chỉ bỏ cột chi phí GHN mới, giữ nguyên khoản khấu trừ cũ để không mất lịch sử refund.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_return_requests" DROP COLUMN IF EXISTS "return_shipping_cost"`);
  }
}
