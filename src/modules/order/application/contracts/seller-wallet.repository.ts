// Cổng nghiệp vụ ví seller; application service không truy vấn trực tiếp hoặc phụ thuộc TypeORM.
import type { SellerWalletSnapshot } from '@/modules/order/application/types/finance/seller-wallet.type';
import type {
    AdminFinanceSnapshot,
    AdminCodRemittanceRecord,
    AdminWalletWithdrawalRecord,
    PlatformFinanceLedgerRecord,
    WalletDepositRecord,
    WalletWithdrawalRecord,
} from '@/modules/order/application/types/finance/wallet-finance.type';
import type {
    WithdrawalConfirmationResult,
    WithdrawalTransferLookup,
    WithdrawalTransferStagingResult,
} from '@/modules/order/application/types/payments/pay2s-payout.type';

export const SELLER_WALLET_REPOSITORY = Symbol('SELLER_WALLET_REPOSITORY');

// Các thao tác ghi nhận/đọc ví được triển khai ở infrastructure để giữ ledger cùng số dư nhất quán.
export interface SellerWalletRepositoryPort {
    creditOrderPending(orderId: string): Promise<void>;
    confirmCodRemittance(
        orderId: string,
        adminId: string,
        reference: string,
    ): Promise<void>;
    reverseRefund(returnRequestId: string): Promise<void>;
    recordCodRefund(input: {
        returnRequestId: string;
        adminId: string;
        reference: string;
        amount: string;
        proof: Record<string, unknown>;
    }): Promise<void>;
    getSnapshot(
        shopId: string,
        page: number,
        pageSize: number,
    ): Promise<SellerWalletSnapshot>;
    releaseCompletedOrder(orderId: string): Promise<void>;
    recordReturnShippingFee(
        returnRequestId: string,
        amount: string,
    ): Promise<void>;
    recordCustomerReturnShippingReceivable(
        returnRequestId: string,
        amount: string,
    ): Promise<void>;
    createWalletDeposit(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        merchantReference: string;
        expiresAt: Date;
        environment?: 'LIVE' | 'SANDBOX';
        providerRequestId?: string;
    }): Promise<WalletDepositRecord>;
    updateWalletDepositProvider(input: {
        depositId: string;
        providerOrderInfo: string;
        providerResponse: Record<string, unknown>;
    }): Promise<void>;
    getWalletDepositByReference(merchantReference: string): Promise<{
        id: string;
        shopId: string;
        sellerUserId: string;
        amount: string;
        status: string;
        expiresAt: Date;
        providerTransactionId: string | null;
    } | null>;
    confirmWalletDeposit(input: {
        depositId: string;
        transactionId: string;
        providerResponse: Record<string, unknown>;
    }): Promise<'PAID' | 'DUPLICATE' | 'NOT_PENDING'>;
    failWalletDeposit(
        depositId: string,
        providerResponse: Record<string, unknown>,
    ): Promise<void>;
    requestWithdrawal(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        bankCode: string;
        bankName: string;
        accountHolder: string;
        accountNumber: string;
    }): Promise<WalletWithdrawalRecord>;
    listSellerWithdrawals(
        shopId: string,
        page: number,
        pageSize: number,
    ): Promise<{ items: WalletWithdrawalRecord[]; total: number }>;
    getAdminFinance(
        page: number,
        pageSize: number,
    ): Promise<AdminFinanceSnapshot>;
    listAdminWithdrawals(
        page: number,
        pageSize: number,
        status?: string,
    ): Promise<{ items: WalletWithdrawalRecord[]; total: number }>;
    listPendingCodRemittances(
        page: number,
        pageSize: number,
    ): Promise<{ items: AdminCodRemittanceRecord[]; total: number }>;
    getAdminWithdrawal(
        withdrawalId: string,
    ): Promise<AdminWalletWithdrawalRecord>;
    transitionWithdrawal(input: {
        withdrawalId: string;
        adminId: string;
        status: 'PROCESSING' | 'REJECTED';
        note?: string;
    }): Promise<void>;
    stagePay2sWithdrawalTransfer(
        input: WithdrawalTransferLookup & {
            amount: string;
            providerTransactionId: string;
            transactionNumber: string | null;
        },
    ): Promise<WithdrawalTransferStagingResult>;
    confirmPay2sWithdrawalTransfer(input: {
        withdrawalId: string;
        adminId: string;
        note?: string;
    }): Promise<WithdrawalConfirmationResult>;
    getPlatformLedger(
        page: number,
        pageSize: number,
    ): Promise<{ items: PlatformFinanceLedgerRecord[]; total: number }>;
    createSettlementBatch(input: {
        adminId: string;
        note?: string;
        ledgerIds: string[];
    }): Promise<{ id: string; ledgerCount: number }>;
    reconcileSettlementBatch(input: {
        batchId: string;
        adminId: string;
    }): Promise<void>;
}
