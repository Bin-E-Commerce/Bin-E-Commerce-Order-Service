import { MigrationInterface, QueryRunner } from 'typeorm';

// Khôi phục trách nhiệm phí theo semantics cũ cho request OTHER chưa hoàn tất trước khi có bước seller review payer.
export class BackfillLegacyReturnShippingPayer1788040000000
    implements MigrationInterface
{
    name = 'BackfillLegacyReturnShippingPayer1788040000000';

    // Request OTHER cũ mặc định tính phí chiều ngược cho customer; chỉ backfill state chưa nhận kiện để không sửa lịch sử đã chốt.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "order_return_requests"
            SET "return_shipping_payer" = 'CUSTOMER'
            WHERE "reason" = 'OTHER'
              AND "return_shipping_payer" IS NULL
              AND "status" IN ('AWAITING_SHIPMENT', 'IN_TRANSIT')
        `);
    }

    // Không đảo dữ liệu vì một request có thể đã được seller xử lý sau khi migration chạy.
    public async down(): Promise<void> {}
}
