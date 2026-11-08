// Cổng đọc công nợ ví seller và đồng bộ dấu đã khóa; SQL vẫn thuộc infrastructure.
import type {
    AdminSellerWalletDebtSummary,
    AdminSellerWalletDebtListQuery,
    AdminSellerWalletDebtPage,
    SellerWalletDebtLockCandidate,
    SellerWalletDebtRecord,
} from '@/modules/order/application/types/finance/seller-wallet-debt.type';

export const SELLER_WALLET_DEBT_REPOSITORY = Symbol(
    'SELLER_WALLET_DEBT_REPOSITORY',
);

// Các thao tác chỉ đọc số dư âm và đánh dấu trạng thái đã đồng bộ sang Seller Service.
export interface SellerWalletDebtRepositoryPort {
    getForShop(shopId: string): Promise<SellerWalletDebtRecord | null>;
    getAdminSummary(): Promise<AdminSellerWalletDebtSummary>;
    listAdminDebts(
        query: AdminSellerWalletDebtListQuery,
    ): Promise<AdminSellerWalletDebtPage>;
    findLockCandidates(
        debtLimit: string,
        limit: number,
    ): Promise<SellerWalletDebtLockCandidate[]>;
    markFinanceLockSynced(shopId: string, locked: boolean): Promise<void>;
}
