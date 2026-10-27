// Tiện ích tạo và xác thực chữ ký Pay2S; không đọc config và không gửi request mạng.
import { createHmac, timingSafeEqual } from 'node:crypto';

type Scalar = string | number;

// Ký HMAC-SHA256 trên canonical string đã được caller sắp đúng thứ tự Pay2S; không encode lại dữ liệu.
function sign(raw: string, secretKey: string): string {
    return createHmac('sha256', secretKey).update(raw, 'utf8').digest('hex');
}

// So sánh chữ ký bằng timing-safe comparison và từ chối secret/chữ ký sai format trước khi so sánh.
function verify(raw: string, received: string, secretKey: string): boolean {
    if (!secretKey || !/^[a-f0-9]{64}$/i.test(received)) return false;
    const expected = sign(raw, secretKey);
    return timingSafeEqual(
        Buffer.from(received.toLowerCase(), 'hex'),
        Buffer.from(expected, 'hex'),
    );
}

// V2 ký đúng thứ tự Pay2S quy định; bankAccounts được biểu diễn là Array và extraData không URL encode.
// Chuỗi này chỉ dành cho create, không dùng lại cho cancel, redirect hoặc IPN.
export function createPay2sCreateSignature(input: {
    accessKey: string;
    amount: Scalar;
    extraData: string;
    ipnUrl: string;
    orderId: string;
    orderInfo: string;
    partnerCode: string;
    redirectUrl: string;
    requestId: Scalar;
    requestType: string;
    secretKey: string;
}): string {
    const raw = [
        `accessKey=${input.accessKey}`,
        `amount=${input.amount}`,
        'bankAccounts=Array',
        `extraData=${input.extraData}`,
        `ipnUrl=${input.ipnUrl}`,
        `orderId=${input.orderId}`,
        `orderInfo=${input.orderInfo}`,
        `partnerCode=${input.partnerCode}`,
        `redirectUrl=${input.redirectUrl}`,
        `requestId=${input.requestId}`,
        `requestType=${input.requestType}`,
        'signatureVersion=2',
    ].join('&');
    return sign(raw, input.secretKey);
}

// Tạo chữ ký cancel riêng của Pay2S; requestId là mã mới cho lần hủy, không dùng lại requestId create.
export function createPay2sCancelSignature(input: {
    accessKey: string;
    orderId: string;
    partnerCode: string;
    requestId: string;
    requestType: 'cancel';
    secretKey: string;
}): string {
    const raw = [
        `accessKey=${input.accessKey}`,
        `orderId=${input.orderId}`,
        `partnerCode=${input.partnerCode}`,
        `requestId=${input.requestId}`,
        `requestType=${input.requestType}`,
    ].join('&');
    return sign(raw, input.secretKey);
}

// Xác minh redirect chỉ theo các trường Pay2S quy định; redirect không tự xác nhận payment.
export function verifyPay2sRedirectSignature(
    payload: {
        accessKey: Scalar;
        amount: Scalar;
        message: Scalar;
        orderId: Scalar;
        orderInfo: Scalar;
        orderType: Scalar;
        partnerCode: Scalar;
        payType: Scalar;
        requestId: Scalar;
        responseTime: Scalar;
        resultCode: Scalar;
        m2signature: string;
    },
    secretKey: string,
): boolean {
    const raw = [
        `accessKey=${payload.accessKey}`,
        `amount=${payload.amount}`,
        `message=${payload.message}`,
        `orderId=${payload.orderId}`,
        `orderInfo=${payload.orderInfo}`,
        `orderType=${payload.orderType}`,
        `partnerCode=${payload.partnerCode}`,
        `payType=${payload.payType}`,
        `requestId=${payload.requestId}`,
        `responseTime=${payload.responseTime}`,
        `resultCode=${payload.resultCode}`,
    ].join('&');
    return verify(raw, payload.m2signature, secretKey);
}

// Xác minh IPN theo canonical string riêng; requestTrace không tham gia chữ ký theo contract Pay2S.
export function verifyPay2sIpnSignature(
    payload: {
        accessKey: Scalar;
        amount: Scalar;
        extraData: Scalar;
        message: Scalar;
        orderId: Scalar;
        orderInfo: Scalar;
        orderType: Scalar;
        partnerCode: Scalar;
        payType: Scalar;
        requestId: Scalar;
        responseTime: Scalar;
        resultCode: Scalar;
        transId: Scalar;
        m2signature: string;
    },
    secretKey: string,
): boolean {
    const raw = [
        `accessKey=${payload.accessKey}`,
        `amount=${payload.amount}`,
        `extraData=${payload.extraData}`,
        `message=${payload.message}`,
        `orderId=${payload.orderId}`,
        `orderInfo=${payload.orderInfo}`,
        `orderType=${payload.orderType}`,
        `partnerCode=${payload.partnerCode}`,
        `payType=${payload.payType}`,
        `requestId=${payload.requestId}`,
        `responseTime=${payload.responseTime}`,
        `resultCode=${payload.resultCode}`,
        `transId=${payload.transId}`,
    ].join('&');
    return verify(raw, payload.m2signature, secretKey);
}
