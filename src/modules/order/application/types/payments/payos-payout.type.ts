// Hợp đồng nội bộ cho lệnh chi payOS; không đưa khóa cấu hình hay số tài khoản ra khỏi Order Service.
export interface PayosPayoutRequest {
    referenceId: string;
    amount: number;
    description: string;
    toBin: string;
    toAccountNumber: string;
}

export interface PayosPayoutTransaction {
    id: string;
    referenceId: string;
    amount: number;
    toBin: string;
    toAccountNumber: string;
    toAccountName: string | null;
    reference: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    state: string;
}

export interface PayosPayout {
    id: string;
    referenceId: string;
    approvalState: string;
    transactions: PayosPayoutTransaction[];
}

export interface PayosPayoutReadiness {
    ready: boolean;
    missing: Array<'CLIENT_ID' | 'API_KEY' | 'CHECKSUM_KEY'>;
    balance: string | null;
}

export interface AdminSellerPayoutResult {
    status: 'PROCESSING' | 'PAID' | 'FAILED';
    approvalState: string | null;
    transactionState: string | null;
}
