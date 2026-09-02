// Migration này lưu bằng chứng ảnh/video của delivery issue để Customer chỉ cần gửi dữ liệu một lần.
// Cột JSONB giữ snapshot URL/assetId, không phụ thuộc việc Media Service có thay đổi metadata về sau.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeliveryIssueEvidence1788014000000 implements MigrationInterface {
  name = "AddDeliveryIssueEvidence1788014000000";

  // Bổ sung evidence với giá trị rỗng cho issue cũ để migration không làm mất dữ liệu lịch sử.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_delivery_issues" ADD "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }

  // Xóa đúng cột được migration này sở hữu khi rollback.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_delivery_issues" DROP COLUMN "evidence"`);
  }
}
