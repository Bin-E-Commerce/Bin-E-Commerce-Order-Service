// Snapshot nhỏ dùng cho callback trạng thái shipment; không để Shipping Service nhận Order entity.
import type { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import type { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';

// Service chỉ phát event sau khi adapter đã commit state transition và trả cờ changed để callback retry idempotent.
export interface ReturnShipmentSyncRecord {
    id: string;
    orderId: string;
    ownerId: string;
    shopId: string;
    sellerUserId: string | null;
    status: OrderReturnStatus;
    refundAmount: string;
    reason: OrderReturnReason;
    reviewNote: string | null;
    shipmentFailureNote: string | null;
    changed: boolean;
}
