// Hợp đồng dữ liệu tối thiểu cho màn hình thanh toán Pay2S của khách hàng.

export type Pay2sCustomerPaymentStatus =
    | 'PENDING'
    | 'PAID'
    | 'REFUND_PENDING'
    | 'REFUNDED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'RETRYABLE';

export interface Pay2sCustomerPaymentDetails {
    orderId: string;
    orderNumber: string;
    amount: string;
    status: Pay2sCustomerPaymentStatus;
    expiresAt: string | null;
    bankName: string | null;
    accountHolder: string | null;
    accountNumber: string | null;
    orderInfo: string | null;
    qrData: string | null;
    qrUrl: string | null;
    paymentUrl: string | null;
}
