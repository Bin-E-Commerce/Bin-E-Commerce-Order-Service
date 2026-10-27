// Hợp đồng webhook giao dịch tiền ra SePay; payload bên ngoài luôn được kiểm tra lại lúc chạy.
export interface SepayBankTransaction {
    id?: string | number;
    referenceCode?: string | null;
    accountNumber?: string;
    content?: string;
    transferType?: string;
    transferAmount?: string | number;
    code?: string;
}

export type WithdrawalTransferReconciliationResult =
    | 'PAID'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'NOT_PROCESSING'
    | 'AMOUNT_MISMATCH'
    | 'ALREADY_PAID';

export type WithdrawalPayoutFailureResult =
    | 'FAILED'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'NOT_PROCESSING';
