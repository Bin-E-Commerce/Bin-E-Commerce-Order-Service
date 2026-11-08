// Cổng nguyên tử để customer hủy return request và mở lại bước xác nhận giao hàng nếu cần.

import type { ReturnRequestCancellationResult } from '@/modules/order/application/types/returns/return-request-cancellation.type';

export const RETURN_REQUEST_CANCELLATION_REPOSITORY = Symbol(
    'RETURN_REQUEST_CANCELLATION_REPOSITORY',
);

export interface ReturnRequestCancellationRepositoryPort {
    // Hủy request REQUESTED hoặc retry idempotent để phục hồi order RETURN_REFUND cũ không còn return nào mở.
    cancelRequested(
        ownerId: string,
        returnId: string,
    ): Promise<ReturnRequestCancellationResult>;
}
