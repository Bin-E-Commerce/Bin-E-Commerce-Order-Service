// Hợp đồng wallet finance mô tả số liệu và thao tác mà API có thể chuyển qua service boundary.
export interface WalletDepositRecord {
    id: string;
    amount: string;
    status: string;
    createdAt: string;
    confirmedAt: string | null;
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
    sandboxDepositTotal: string;
    ledger: PlatformFinanceLedgerRecord[];
    withdrawals: WalletWithdrawalRecord[];
    deposits: WalletDepositRecord[];
    totalLedger: number;
    page: number;
    pageSize: number;
}
