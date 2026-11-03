// Tài khoản ngân hàng do khách cung cấp để admin chuyển hoàn cho khoản Pay2S đã thu.
export interface RefundBankAccountInput {
    bankCode: string;
    bankName: string;
    accountHolder: string;
    accountNumber: string;
}
