import { MigrationInterface, QueryRunner } from "typeorm";

// Migration bổ sung chủ sở hữu shop vào snapshot order item để event hủy đơn không cần gọi ngược catalog.
export class AddSellerOwnerOrderItem1788002000000 implements MigrationInterface {
  name = "AddSellerOwnerOrderItem1788002000000";

  // Thêm cột nullable để dữ liệu order cũ vẫn đọc được và chỉ order mới có đầy đủ recipient seller.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD "seller_owner_id" uuid`,
    );
  }

  // Xóa đúng cột migration sở hữu khi rollback schema.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "seller_owner_id"`,
    );
  }
}
