// Migration này bảo đảm mỗi order/shop chỉ có một quy trình hoàn hàng đang mở.
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddActiveReturnUniqueIndex1788017000000 implements MigrationInterface {
  name = "AddActiveReturnUniqueIndex1788017000000";

  // Unique partial index là lớp bảo vệ cuối cùng cho hai request tạo đồng thời sau cùng một lần kiểm tra.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_order_return_active_order_shop"
      ON "order_return_requests" ("order_id", "shop_id")
      WHERE "status" IN (
        'REQUESTED'::"order_return_status_enum",
        'AWAITING_SHIPMENT'::"order_return_status_enum",
        'IN_TRANSIT'::"order_return_status_enum",
        'SHIPMENT_FAILED'::"order_return_status_enum",
        'RECEIVED'::"order_return_status_enum",
        'REFUND_PENDING'::"order_return_status_enum"
      )
    `);
  }

  // Xóa đúng index do migration này sở hữu, không tác động dữ liệu return request.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_order_return_active_order_shop"`);
  }
}
