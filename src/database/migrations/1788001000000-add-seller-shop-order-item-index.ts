import { MigrationInterface, QueryRunner } from "typeorm";

// Migration thêm index cho truy vấn Seller theo shop mà không thay đổi dữ liệu order snapshot hiện có.
export class AddSellerShopOrderItemIndex1788001000000
  implements MigrationInterface
{
  name = "AddSellerShopOrderItemIndex1788001000000";

  // Tạo index ghép để lọc item theo shop rồi liên kết ngược về order ổn định.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_order_items_seller_shop_order" ON "order_items" ("seller_shop_id", "order_id")`,
    );
  }

  // Rollback chỉ gỡ index đã tạo, không ảnh hưởng dữ liệu order.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "idx_order_items_seller_shop_order"`,
    );
  }
}
