// Snapshot tối thiểu để seller cân nhắc phí shop chịu trước khi duyệt yêu cầu hoàn.
export interface SellerReturnFinancePreview {
    availableBalance: string;
    currentDebtBalance: string;
    estimatedOutboundShippingFee: string;
    estimatedReturnShippingFee: string;
    estimatedShippingFee: string;
    debtLimit: string;
    shopLocked: boolean;
}
