import {
    createPay2sCancelSignature,
    createPay2sCreateSignature,
    verifyPay2sIpnSignature,
    verifyPay2sRedirectSignature,
} from '@/modules/order/application/utils/payments/pay2s-signature.util';

describe('Pay2S signature utilities', () => {
    const secretKey = 'secret-key';

    // Bảo vệ canonical string V2: extraData không URL encode và bankAccounts dùng literal Array.
    it('should create a stable Collection Link V2 signature', () => {
        const signature = createPay2sCreateSignature({
            accessKey: 'access',
            amount: 120000,
            extraData: 'eyJpdGVtcyI6W119',
            ipnUrl: 'https://example.test/ipn',
            orderId: 'ORDER_1',
            orderInfo: 'Thanh toan',
            partnerCode: 'partner',
            redirectUrl: 'https://example.test/return',
            requestId: 'REQ_1',
            requestType: 'pay2s',
            secretKey,
        });

        expect(signature).toHaveLength(64);
        expect(signature).toBe(
            '44268a8b201990f7c3e3303e542ddb07aa601c39440711b45fc6fcb6f21ac894',
        );
    });

    // Cancel có canonical string độc lập với create, không được dùng lại chữ ký thanh toán.
    it('should create a cancel signature with the cancel request type', () => {
        const signature = createPay2sCancelSignature({
            accessKey: 'access',
            orderId: 'ORDER_1',
            partnerCode: 'partner',
            requestId: 'CANCEL_1',
            requestType: 'cancel',
            secretKey,
        });

        expect(signature).toHaveLength(64);
        expect(signature).not.toBe(
            createPay2sCancelSignature({
                accessKey: 'access',
                orderId: 'ORDER_2',
                partnerCode: 'partner',
                requestId: 'CANCEL_1',
                requestType: 'cancel',
                secretKey,
            }),
        );
    });

    // Verify redirect và IPN phải chấp nhận giá trị số/string nhưng giữ nguyên giá trị khi ký.
    it('should verify redirect and IPN signatures only when all signed fields match', () => {
        const redirect = {
            accessKey: 'access',
            amount: '120000',
            message: 'Paymentsuccessful',
            orderId: 'ORDER_1',
            orderInfo: 'P2S123',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: '1',
            responseTime: '1700000000',
            resultCode: '0',
            m2signature: '',
        };
        const redirectRaw = [
            `accessKey=${redirect.accessKey}`,
            `amount=${redirect.amount}`,
            `message=${redirect.message}`,
            `orderId=${redirect.orderId}`,
            `orderInfo=${redirect.orderInfo}`,
            `orderType=${redirect.orderType}`,
            `partnerCode=${redirect.partnerCode}`,
            `payType=${redirect.payType}`,
            `requestId=${redirect.requestId}`,
            `responseTime=${redirect.responseTime}`,
            `resultCode=${redirect.resultCode}`,
        ].join('&');
        const { createHmac } =
            require('node:crypto') as typeof import('node:crypto');
        redirect.m2signature = createHmac('sha256', secretKey)
            .update(redirectRaw)
            .digest('hex');
        expect(verifyPay2sRedirectSignature(redirect, secretKey)).toBe(true);
        expect(
            verifyPay2sRedirectSignature(
                { ...redirect, amount: '120001' },
                secretKey,
            ),
        ).toBe(false);

        const ipn = {
            accessKey: 'access',
            amount: 120000,
            extraData: '',
            message: 'Paymentsuccessful',
            orderId: 'ORDER_1',
            orderInfo: 'P2S123',
            orderType: 'pay2s',
            partnerCode: 'partner',
            payType: 'pay2s',
            requestId: 1,
            responseTime: 1700000000000,
            resultCode: 0,
            transId: 'TRANS_1',
            m2signature: '',
        };
        const ipnRaw = [
            `accessKey=${ipn.accessKey}`,
            `amount=${ipn.amount}`,
            `extraData=${ipn.extraData}`,
            `message=${ipn.message}`,
            `orderId=${ipn.orderId}`,
            `orderInfo=${ipn.orderInfo}`,
            `orderType=${ipn.orderType}`,
            `partnerCode=${ipn.partnerCode}`,
            `payType=${ipn.payType}`,
            `requestId=${ipn.requestId}`,
            `responseTime=${ipn.responseTime}`,
            `resultCode=${ipn.resultCode}`,
            `transId=${ipn.transId}`,
        ].join('&');
        ipn.m2signature = createHmac('sha256', secretKey)
            .update(ipnRaw)
            .digest('hex');
        expect(verifyPay2sIpnSignature(ipn, secretKey)).toBe(true);
    });
});
