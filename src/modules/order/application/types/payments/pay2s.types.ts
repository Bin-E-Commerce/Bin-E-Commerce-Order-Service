// Contract nội bộ cho Collection Link V2, IPN và redirect của Pay2S.
// Application service chỉ sử dụng các kiểu này; chi tiết HTTP và chữ ký nằm ở gateway adapter.

export type Pay2sEnvironment = 'LIVE' | 'SANDBOX';

export interface Pay2sInvoiceMetadata {
    invoiceType: 'none';
    customerInfo: {
        buyerContactName: string;
        buyerCompanyName: string;
        taxCode: string;
        citizenId: string;
        address: string;
        email: string;
        phone: string;
    };
    items: Array<{
        externalItemId: string;
        itemName: string;
        unit: string;
        quantity: number;
        unitPrice: number;
        taxRate: number;
    }>;
    invoiceOptions: {
        requested: false;
        buyerNotTakingInvoice: true;
        paymentMethod: 'Chuyển khoản';
        note: string;
        source: 'api';
    };
}

export interface Pay2sCreatePaymentInput {
    orderId: string;
    requestId: string;
    amount: string;
    orderInfo: string;
    redirectUrl: string;
    ipnUrl: string;
    metadata: Pay2sInvoiceMetadata;
    environment: Pay2sEnvironment;
}

export interface Pay2sCreatePaymentResult {
    payUrl: string;
    orderInfo: string;
    requestId: string;
    response: Record<string, unknown>;
}

export interface Pay2sCancelPaymentInput {
    orderId: string;
    requestId: string;
    environment: Pay2sEnvironment;
}

export interface Pay2sCancelPaymentResult {
    resultCode: string;
    status: string;
    response: Record<string, unknown>;
}

export interface Pay2sRedirectPayload {
    accessKey: string;
    amount: string | number;
    message: string;
    orderId: string;
    orderInfo: string;
    orderType: string;
    partnerCode: string;
    payType: string;
    requestId: string | number;
    responseTime: string | number;
    resultCode: string | number;
    transId?: string;
    m2signature: string;
}

export interface Pay2sIpnPayload {
    accessKey: string;
    amount: string | number;
    extraData: string;
    message: string;
    orderId: string;
    orderInfo: string;
    orderType: string;
    partnerCode: string;
    payType: string;
    requestId: string | number;
    requestTrace?: string;
    responseTime: string | number;
    resultCode: string | number;
    transId: string;
    m2signature: string;
}
