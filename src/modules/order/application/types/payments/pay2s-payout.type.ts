// Hợp đồng webhook giao dịch Pay2S OUT; payload bên ngoài luôn được kiểm tra lúc chạy.
export interface Pay2sBankTransaction {
    id?: string | number;
    transactionNumber?: string | number;
    accountNumber?: string;
    content?: string;
    transferType?: string;
    transferAmount?: string | number;
    checksum?: string;
}

// Khóa tìm payout từ webhook: mã cũ nhúng UUID đầy đủ, mã mới dùng memo ngắn được lưu duy nhất trong DB.
export type WithdrawalTransferLookup =
    | { withdrawalId: string; transferMemoCode?: never }
    | { withdrawalId?: never; transferMemoCode: string };

export type WithdrawalTransferStagingResult =
    | 'STAGED'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'NOT_PROCESSING'
    | 'AMOUNT_MISMATCH'
    | 'ALREADY_PAID'
    | 'ALREADY_HAS_EVENT'
    | 'LEGACY_PROCESSING'
    | 'EVENT_ALREADY_USED';

export type WithdrawalConfirmationResult =
    | 'PAID'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'NOT_PROCESSING'
    | 'TRANSFER_NOT_DETECTED';
