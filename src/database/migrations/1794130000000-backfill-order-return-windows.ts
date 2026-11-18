// Migration này khởi tạo deadline cho đơn đã giao hoặc đang xử lý hoàn để release worker giữ đúng tiền seller.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillOrderReturnWindows1794130000000 implements MigrationInterface {
    name = 'BackfillOrderReturnWindows1794130000000';

    // Dùng deliveredAt chuẩn; completedAt là mốc dự phòng cho dữ liệu cũ thiếu timestamp giao.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "orders"
            SET "return_window_until" =
                COALESCE("delivered_at", "completed_at", NOW()) + INTERVAL '168 hours'
            WHERE "return_window_until" IS NULL
              AND "fulfillment_status" IN ('DELIVERED', 'COMPLETED', 'RETURN_REFUND')
        `);
    }

    // Giữ lại deadline đã backfill khi rollback ứng dụng để không xóa dữ liệu nghiệp vụ đã phát sinh.
    public down(): Promise<void> {
        return Promise.resolve();
    }
}
