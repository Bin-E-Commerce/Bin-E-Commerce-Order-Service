// Cổng đọc snapshot của khoản hoàn đã được ghi nhận; application service không tự truy vấn các entity tài chính.

import type {
    RefundCompletionSourceType,
    RefundCompletionSnapshot,
} from '@/modules/order/application/types/finance/refund-completion.type';

export const REFUND_COMPLETION_REPOSITORY = Symbol(
    'REFUND_COMPLETION_REPOSITORY',
);

export interface RefundCompletionRepositoryPort {
    findCompletedRefund(
        sourceType: RefundCompletionSourceType,
        refundId: string,
    ): Promise<RefundCompletionSnapshot | null>;
}
