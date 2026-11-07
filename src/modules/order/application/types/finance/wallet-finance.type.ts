// Hợp đồng wallet finance mô tả số liệu và thao tác mà API có thể chuyển qua service boundary.
export interface WalletDepositRecord {
    id: string;
    amount: string;
    status: string;
    createdAt: string;
    confirmedAt: string | null;
}

// Bổ sung mã shop để dashboard admin xác định nguồn nạp mà không trả dữ liệu cá nhân.
export interface AdminWalletDepositRecord extends WalletDepositRecord {
    shopId: string;
}

export interface WalletWithdrawalRecord {
    id: string;
    shopId: string;
    amount: string;
    bankName: string;
    accountHolder: string;
    accountNumberMasked: string;
    status: string;
    transferReference: string | null;
    adminNote: string | null;
    createdAt: string;
    processedAt: string | null;
}

export interface AdminWalletWithdrawalRecord extends WalletWithdrawalRecord {
    bankCode: string;
    accountNumber: string;
    sellerUserId: string;
    transferMemo: string;
    pay2sTransactionId: string | null;
    pay2sTransactionNumber: string | null;
    pay2sTransferAmount: string | null;
    pay2sTransferDetectedAt: string | null;
    recipientConfirmedBy: string | null;
    recipientConfirmedAt: string | null;
}

// Dữ liệu tối thiểu để admin xác nhận COD đã thu, không trả thông tin cá nhân của khách.
export interface AdminCodRemittanceRecord {
    orderId: string;
    orderNumber: string;
    amount: string;
    completedAt: string;
    createdAt: string;
}

// Hồ sơ hoàn đang chờ, lỗi hoặc hoàn tất.
// Nguồn được giữ riêng để admin phân biệt các luồng nghiệp vụ.
export interface AdminRefundRecord {
    sourceType: 'PAYMENT_ATTEMPT' | 'ORDER_RETURN' | 'DELIVERY_ISSUE';
    id: string;
    orderId: string;
    orderNumber: string;
    paymentMethod: 'COD' | 'PAY2S';
    status: 'REFUND_PENDING' | 'REFUND_FAILED' | 'REFUNDED';
    amount: string;
    reason: string;
    providerTransactionId: string | null;
    refundBankCode: string | null;
    refundBankName: string | null;
    refundAccountHolder: string | null;
    refundAccountNumber: string | null;
    refundTransferMemo: string | null;
    refundFailureNote: string | null;
    refundOutTransactionId: string | null;
    refundOutTransactionNumber: string | null;
    refundOutAmount: string | null;
    refundOutDetectedAt: string | null;
    refundProcessedAt: string | null;
    createdAt: string;
}

// Dữ liệu cần cho admin phân xử khiếu nại chưa được chuyển sang yêu cầu trả hàng.
export interface AdminDeliveryIssueRecord {
    id: string;
    orderId: string;
    orderNumber: string;
    paymentStatus:
        | 'COD_PENDING_COLLECTION'
        | 'PENDING'
        | 'FAILED'
        | 'PAID'
        | 'REFUND_PENDING'
        | 'REFUNDED';
    reason: string;
    itemIds: string[];
    note: string | null;
    evidence: Array<{ assetId: string; url: string; type: 'image' | 'video' }>;
    returnRequestId: string | null;
    createdAt: string;
}

export interface PlatformFinanceLedgerRecord {
    id: string;
    kind: string;
    amount: string;
    shopId: string | null;
    orderId: string | null;
    returnRequestId: string | null;
    reference: string | null;
    settlementBatchId: string | null;
    createdBy: string | null;
    createdAt: string;
}

export interface AdminFinanceSnapshot {
    platformBalance: string;
    sellerPayableBalance: string;
    reservedWithdrawalBalance: string;
    shippingFundBalance: string;
    customerReturnShippingReceivable: string;
    pendingWithdrawals: number;
    depositTotal: string;
    ledger: PlatformFinanceLedgerRecord[];
    withdrawals: WalletWithdrawalRecord[];
    deposits: AdminWalletDepositRecord[];
    totalLedger: number;
    page: number;
    pageSize: number;
    sellerDebtBalance?: string;
    sellerDebtShopCount?: number;
    overdueSellerDebtBalance?: string;
    overdueSellerDebtShopCount?: number;
    sellerDebtLockedShopCount?: number;
}

// Các chuỗi đếm cho biểu đồ vận hành; không trả số dư hoặc thông tin tài khoản seller.
export interface AdminWalletActivityDailyCount {
    day: string;
    count: number;
}

export interface AdminWalletActivityData {
    from: string;
    to: string;
    deposits: AdminWalletActivityDailyCount[];
    withdrawalRequests: AdminWalletActivityDailyCount[];
}
