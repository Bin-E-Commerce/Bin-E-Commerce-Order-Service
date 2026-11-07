// Hợp đồng đọc công nợ seller và các trạng thái cần đồng bộ để tạm khóa shop quá hạn.
export interface SellerWalletDebtRecord {
    debtBalance: string;
    dueAt: Date | null;
    financeLockedAt: Date | null;
}

export interface SellerWalletDebtSnapshot {
    debtBalance: string;
    debtLimit: string;
    debtDueDays: number;
    dueAt: string | null;
    isAtLimit: boolean;
    isOverdue: boolean;
    shopLocked: boolean;
}

export interface SellerWalletDebtLockCandidate {
    shopId: string;
    locked: boolean;
}

export interface AdminSellerWalletDebtSummary {
    sellerDebtBalance: string;
    sellerDebtShopCount: number;
    overdueSellerDebtBalance: string;
    overdueSellerDebtShopCount: number;
    sellerDebtLockedShopCount: number;
}
