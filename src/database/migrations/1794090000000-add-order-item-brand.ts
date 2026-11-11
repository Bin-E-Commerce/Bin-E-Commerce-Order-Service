// Migration này lưu brand snapshot trên order item để purchase/return event giữ đúng metadata lúc checkout.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderItemBrand1794090000000 implements MigrationInterface {
    name = 'AddOrderItemBrand1794090000000';

    // Cột nullable giữ nguyên khả năng đọc order cũ vốn chưa lưu thương hiệu.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "brand_id" uuid',
        );
    }

    // Rollback chỉ gỡ snapshot brand do migration này sở hữu.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "order_items" DROP COLUMN IF EXISTS "brand_id"',
        );
    }
}
