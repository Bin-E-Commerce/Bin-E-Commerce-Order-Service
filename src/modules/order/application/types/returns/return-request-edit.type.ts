// Các snapshot và kết quả ghi dành riêng cho customer sửa request còn chờ shop xử lý.

import type { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import type { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import type { ReturnRefundCalculationOrderSnapshot } from '@/modules/order/application/types/returns/return-refund-calculation.type';

export interface ReturnRequestEditSnapshot {
    id: string;
    orderId: string;
    orderNumber: string;
    ownerId: string;
    shopId: string;
    sellerUserId: string | null;
    status: OrderReturnStatus;
    updatedAt: string;
    itemIds: string[];
    reason: OrderReturnReason;
    description: string | null;
    evidence: Array<{ assetId: string; url: string; type: 'image' | 'video' }>;
    refundItemAmount: string;
    returnShippingEstimatedCost: string;
    order: ReturnRefundCalculationOrderSnapshot;
}

export interface ReturnRequestEditWrite {
    ownerId: string;
    returnId: string;
    expectedUpdatedAt: string;
    reason: OrderReturnReason;
    description: string | null;
    evidence: ReturnRequestEditSnapshot['evidence'];
    refundItemAmount: string;
    refundShippingAmount: string;
    estimatedRefundAmount: string;
    returnShippingPayer: 'CUSTOMER' | 'SELLER' | null;
}

export interface ReturnRequestEditEventSnapshot {
    id: string;
    orderId: string;
    orderNumber: string;
    ownerId: string;
    shopId: string;
    sellerUserId: string | null;
    status: OrderReturnStatus;
    refundAmount: string;
    reason: OrderReturnReason;
    description: string | null;
    updatedAt: string;
}

export type ReturnRequestEditWriteResult =
    | { kind: 'UPDATED'; snapshot: ReturnRequestEditEventSnapshot }
    | { kind: 'NOT_FOUND' }
    | { kind: 'NOT_EDITABLE' }
    | { kind: 'STALE' };
