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
    accountNumber: string;
    sellerUserId: string;
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
