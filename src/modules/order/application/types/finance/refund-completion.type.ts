// Snapshot tối thiểu của khoản hoàn đã chốt để Order Service thông báo đúng khách mà không lộ tài khoản ngân hàng.

export type RefundCompletionSourceType =
    | 'PAYMENT_ATTEMPT'
    | 'ORDER_RETURN'
    | 'DELIVERY_ISSUE';

export interface RefundCompletionSnapshot {
    refundId: string;
    sourceType: RefundCompletionSourceType;
    orderId: string;
    orderNumber: string;
    customerUserId: string;
    refundAmount: string;
    occurredAt: string;
}
