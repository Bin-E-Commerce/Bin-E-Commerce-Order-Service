// Migration chuyển các yêu cầu đã duyệt sang state chờ customer gửi hàng hoàn.
// Migration chạy sau migration thêm enum để PostgreSQL đã commit value mới trước khi UPDATE.

import { MigrationInterface, QueryRunner } from "typeorm";

export class NormalizeApprovedReturns1788011000000 implements MigrationInterface {
  name = "NormalizeApprovedReturns1788011000000";

  // Chuẩn hóa dữ liệu cũ sau khi enum AWAITING_SHIPMENT đã tồn tại độc lập trong schema.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "order_return_requests" SET "status" = 'AWAITING_SHIPMENT' WHERE "status" = 'APPROVED'`,
    );
  }

  // Khôi phục state APPROVED khi rollback migration dữ liệu này.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "order_return_requests" SET "status" = 'APPROVED' WHERE "status" = 'AWAITING_SHIPMENT'`,
    );
  }
}
