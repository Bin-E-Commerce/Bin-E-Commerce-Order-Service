// Snapshot tối thiểu dùng chung khi tính phần hoàn hàng; không mang entity TypeORM qua application boundary.

export interface ReturnRefundCalculationOrderSnapshot {
    totalAmount?: string | null;
    subtotal: string;
    shippingFee: string;
    shippingFeeBreakdown?: Array<Record<string, unknown>>;
    items?: Array<{
        id: string;
        sellerShopId: string | null;
        lineTotal: string;
    }>;
}
