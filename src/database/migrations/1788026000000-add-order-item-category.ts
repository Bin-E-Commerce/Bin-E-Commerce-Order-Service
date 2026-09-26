import { MigrationInterface, QueryRunner } from 'typeorm';

// Lưu category snapshot tại Order để purchase event có đủ ngữ cảnh cho Recommendation mà không đọc chéo database.
export class AddOrderItemCategory1788026000000 implements MigrationInterface {
    name = 'AddOrderItemCategory1788026000000';

    // Nullable để các order cũ vẫn đọc được và migration không cần suy diễn ngược từ Product Service.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "category_id" uuid`,
        );
    }

    // Xóa snapshot khi rollback feature category purchase projection.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "category_id"`,
        );
    }
}
