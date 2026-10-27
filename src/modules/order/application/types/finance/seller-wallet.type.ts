// Contract dữ liệu seller finance; không chứa withdrawal hoặc giao dịch chuyển tiền ra ngân hàng.
export interface SellerWalletSnapshot {
    shopId: string;
    pendingBalance: string;
    availableBalance: string;
    reservedBalance: string;
    transactions: Array<{
        id: string;
        orderId: string | null;
        // Mã công khai để seller đối chiếu lịch sử ví với danh sách đơn hàng.
        orderNumber: string | null;
        returnRequestId: string | null;
        kind: string;
        amount: string;
        createdAt: string;
        availableAt: string | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
}

// Snapshot tài khoản nhận chỉ hiển thị số đã che; raw account number ở backend chỉ được gửi cho admin có quyền tài chính.
export interface WalletWithdrawalSummary {
    id: string;
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

// Một khoản nạp là giao dịch riêng, không gắn nhầm với order payment attempt.
export interface WalletDepositSummary {
    id: string;
    amount: string;
    status: string;
    createdAt: string;
    confirmedAt: string | null;
}
