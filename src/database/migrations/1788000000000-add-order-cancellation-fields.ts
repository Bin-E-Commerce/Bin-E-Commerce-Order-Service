import { MigrationInterface, QueryRunner } from "typeorm";

// Migration bổ sung dữ liệu hủy đơn để lịch sử order giữ nguyên sau khi trạng thái thay đổi.
export class AddOrderCancellationFields1788000000000
  implements MigrationInterface
{
  name = "AddOrderCancellationFields1788000000000";

  // Thêm cột nullable để không ảnh hưởng các order đã tạo từ Phase 1.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancel_reason" varchar(500)',
    );
    await queryRunner.query(
      'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz',
    );
    await queryRunner.query(
      'ALTER TABLE "order_status_history" ALTER COLUMN "reason" TYPE varchar(500)',
    );
  }

  // Rollback chỉ xóa metadata hủy, không xóa order hoặc status history.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancelled_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancel_reason"',
    );
    await queryRunner.query(
      'ALTER TABLE "order_status_history" ALTER COLUMN "reason" TYPE varchar(255)',
    );
  }
}
