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

// Memo mới gắn UUID payment attempt; memo order number cũ chỉ được dùng nếu tìm đúng một khoản hoàn.
export type RefundTransferLookup =
    | { refundTransferCode: string; legacyOrderNumberCode?: never }
    | { refundTransferCode?: never; legacyOrderNumberCode: string };

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

// Kết quả ghép giao dịch OUT với khoản hoàn Pay2S; chỉ STAGED mới có candidate mới được lưu.
export type RefundTransferStagingResult =
    | 'STAGED'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'AMBIGUOUS'
    | 'NOT_PROCESSING'
    | 'AMOUNT_MISMATCH'
    | 'ALREADY_HAS_EVENT'
    | 'EVENT_ALREADY_USED';

export type WithdrawalConfirmationResult =
    | 'PAID'
    | 'DUPLICATE'
    | 'NOT_FOUND'
    | 'NOT_PROCESSING'
    | 'TRANSFER_NOT_DETECTED';
