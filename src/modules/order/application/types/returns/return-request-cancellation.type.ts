// Snapshot và kết quả chuyển trạng thái khi customer hủy yêu cầu hoàn còn chờ shop.

import type { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import type { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';

export interface ReturnRequestCancellationSnapshot {
    id: string;
    orderId: string;
    orderNumber: string;
    ownerId: string;
    shopId: string;
    sellerUserId: string | null;
    status: OrderReturnStatus;
    refundAmount: string;
    reason: OrderReturnReason;
    reviewNote: string | null;
}

export type ReturnRequestCancellationResult =
    | { kind: 'CANCELLED'; snapshot: ReturnRequestCancellationSnapshot }
    | { kind: 'ALREADY_CANCELLED' }
    | { kind: 'NOT_FOUND' }
    | { kind: 'NOT_CANCELLABLE' };
