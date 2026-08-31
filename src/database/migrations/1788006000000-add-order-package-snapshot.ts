// Bổ sung snapshot thông số kiện hàng để tạo vận đơn không phụ thuộc catalog hiện tại.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrderPackageSnapshot1788006000000 implements MigrationInterface {
  name = "AddOrderPackageSnapshot1788006000000";

  // Cột nullable để dữ liệu order cũ vẫn đọc được; order mới chỉ tạo shipment khi đủ dữ liệu.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_items" ADD "package_weight_grams" integer`);
    await queryRunner.query(`ALTER TABLE "order_items" ADD "package_length_cm" numeric(10,2)`);
    await queryRunner.query(`ALTER TABLE "order_items" ADD "package_width_cm" numeric(10,2)`);
    await queryRunner.query(`ALTER TABLE "order_items" ADD "package_height_cm" numeric(10,2)`);
  }

  // Xóa đúng các cột được migration tạo ra.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "package_height_cm"`);
    await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "package_width_cm"`);
    await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "package_length_cm"`);
    await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "package_weight_grams"`);
  }
}
