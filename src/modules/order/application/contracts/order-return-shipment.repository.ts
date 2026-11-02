// Port cho callback vận đơn hoàn để application service không truy vấn TypeORM trực tiếp.
import type { ReturnShipmentSyncRecord } from '@/modules/order/application/types/returns/return-shipment-sync.type';

export const ORDER_RETURN_SHIPMENT_REPOSITORY = Symbol(
    'ORDER_RETURN_SHIPMENT_REPOSITORY',
);

// Adapter khóa và cập nhật đúng return request trước khi trả snapshot an toàn cho event publisher.
export interface OrderReturnShipmentRepositoryPort {
    markShipmentInTransit(returnId: string): Promise<ReturnShipmentSyncRecord>;
    markShipmentFailed(
        returnId: string,
        note: string,
    ): Promise<ReturnShipmentSyncRecord>;
    markShipmentRetryStarted(
        returnId: string,
    ): Promise<ReturnShipmentSyncRecord>;
}
