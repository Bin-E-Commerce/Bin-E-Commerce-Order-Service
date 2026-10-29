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
