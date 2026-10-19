// Adapter VNPay tạo URL và kiểm tra callback; trạng thái thanh toán chỉ do PaymentService ghi vào DB.
import {
    BadRequestException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {
    createVnpaySignature,
    encodeVnpayValue,
    verifyVnpaySignature,
} from '@/modules/order/application/utils/vnpay-signature.util';

export interface VnpayRefundInput {
    merchantReference: string;
    transactionId: string;
    transactionDate: string;
    amount: string;
    originalAmount: string;
    requestId: string;
    createBy: string;
    orderInfo: string;
    environment: 'LIVE' | 'SANDBOX';
}

// Chuẩn hóa cấu hình gateway; Sandbox được phép dùng ở production cho đồ án nhưng callback vẫn phải xác minh như LIVE.
@Injectable()
export class VnpayGatewayService {
    constructor(private readonly config: ConfigService) {}

    // Xác minh mode trước rồi chỉ đọc credentials của đúng môi trường, không fallback từ Sandbox sang LIVE hoặc ngược lại.
    // NODE_ENV không quyết định có cho dùng Sandbox hay không; cả hai môi trường đều chạy cùng nghiệp vụ sau khi callback hợp lệ.
    // Checkout gọi hàm trước quote/reservation, còn createPaymentUrl gọi lại để chặn cấu hình thiếu khi adapter được dùng độc lập.
    assertCheckoutEnabled(): void {
        const mode = this.config.get<string>('VNPAY_MODE', 'disabled');
        if (mode === 'disabled')
            throw new ServiceUnavailableException(
                'Thanh toán VNPay hiện chưa được bật.',
            );
        if (mode !== 'sandbox' && mode !== 'live')
            throw new ServiceUnavailableException(
                'Cấu hình VNPay không hợp lệ.',
            );
        const prefix = mode === 'sandbox' ? 'VNPAY_SANDBOX' : 'VNPAY_LIVE';
        if (
            !this.config.get<string>(`${prefix}_TMN_CODE`, '') ||
            !this.config.get<string>(`${prefix}_HASH_SECRET`, '') ||
            !this.config.get<string>('VNPAY_RETURN_URL', '') ||
            !this.config.get<string>(`${prefix}_URL`, '')
        ) {
            throw new ServiceUnavailableException(
                'Thiếu cấu hình VNPay cho môi trường đã chọn.',
            );
        }
    }

    // Tạo URL từ snapshot tiền, hạn thanh toán và thông tin merchant do backend sở hữu.
    // Validate cấu hình và giới hạn số tiền trước khi ký; callback IPN sau này mới là bằng chứng thanh toán.
    // Query string và checksum dùng cùng canonical encoder để các ký tự đặc biệt không làm VNPay từ chối chữ ký.
    createPaymentUrl(input: {
        merchantReference: string;
        amount: string;
        orderInfo: string;
        ipAddress: string;
        createdAt?: string;
        expiresAt?: Date;
    }): string {
        const mode = this.config.get<string>('VNPAY_MODE', 'disabled');
        this.assertCheckoutEnabled();
        return this.createPaymentUrlForEnvironment(
            input,
            mode === 'sandbox' ? 'SANDBOX' : 'LIVE',
        );
    }

    // Wallet demo luôn dùng credentials Sandbox, kể cả khi checkout đơn hàng đang cấu hình LIVE.
    createSandboxPaymentUrl(input: {
        merchantReference: string;
        amount: string;
        orderInfo: string;
        ipAddress: string;
        createdAt?: string;
        expiresAt?: Date;
        returnUrl?: string;
    }): string {
        return this.createPaymentUrlForEnvironment(input, 'SANDBOX');
    }

    // Dùng chung canonical query/signature nhưng khóa rõ environment để không thể đổi gateway bằng dữ liệu client.
    private createPaymentUrlForEnvironment(
        input: {
            merchantReference: string;
            amount: string;
            orderInfo: string;
            ipAddress: string;
            createdAt?: string;
            expiresAt?: Date;
            returnUrl?: string;
        },
        environment: 'LIVE' | 'SANDBOX',
    ): string {
        const prefix =
            environment === 'SANDBOX' ? 'VNPAY_SANDBOX' : 'VNPAY_LIVE';
        const tmnCode = this.config.get<string>(`${prefix}_TMN_CODE`, '');
        const secret = this.config.get<string>(`${prefix}_HASH_SECRET`, '');
        const returnUrl =
            input.returnUrl?.trim() ||
            this.config.get<string>('VNPAY_RETURN_URL', '');
        const endpoint = this.config.get<string>(`${prefix}_URL`, '');
        if (!tmnCode || !secret || !returnUrl || !endpoint)
            throw new ServiceUnavailableException(
                'Thiếu cấu hình VNPay Sandbox cho giao dịch ví.',
            );
        try {
            const parsedReturnUrl = new URL(returnUrl);
            if (!['http:', 'https:'].includes(parsedReturnUrl.protocol))
                throw new Error('Unsupported return URL protocol');
        } catch {
            throw new ServiceUnavailableException(
                'Cấu hình URL quay về từ VNPay không hợp lệ.',
            );
        }

        const amount = Number(input.amount);
        if (
            !Number.isSafeInteger(amount) ||
            amount < 5000 ||
            amount > 1_000_000_000
        ) {
            throw new BadRequestException(
                'Số tiền thanh toán VNPay không hợp lệ.',
            );
        }
        const timestamp =
            input.createdAt ?? this.formatVnpayTimestamp(new Date());
        const params: Record<string, string | number> = {
            vnp_Version: '2.1.0',
            vnp_Command: 'pay',
            vnp_TmnCode: tmnCode,
            vnp_Amount: amount * 100,
            vnp_CurrCode: 'VND',
            vnp_TxnRef: input.merchantReference,
            vnp_OrderInfo: input.orderInfo.slice(0, 255),
            vnp_OrderType: 'other',
            vnp_Locale: 'vn',
            vnp_ReturnUrl: returnUrl,
            vnp_IpAddr: this.normalizeIpAddress(input.ipAddress),
            vnp_CreateDate: timestamp,
            vnp_ExpireDate: this.formatVnpayTimestamp(
                input.expiresAt ?? new Date(Date.now() + 15 * 60_000),
            ),
        };
        const signature = createVnpaySignature(params, secret);
        const query = Object.entries(params)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
                ([key, value]) =>
                    `${encodeVnpayValue(key)}=${encodeVnpayValue(String(value))}`,
            )
            .join('&');
        return `${endpoint}?${query}&vnp_SecureHash=${signature}`;
    }

    // Chỉ kiểm chữ ký bằng secret của environment đã ghi trên payment attempt, không lấy environment từ query người gửi.
    // Merchant terminal phải khớp trước khi HMAC được coi là hợp lệ; caller tiếp tục đối chiếu amount/order snapshot.
    verifyCallback(
        params: Record<string, string | number | undefined>,
        environment: 'LIVE' | 'SANDBOX',
    ): boolean {
        const expectedCode = this.config.get<string>(
            environment === 'SANDBOX'
                ? 'VNPAY_SANDBOX_TMN_CODE'
                : 'VNPAY_LIVE_TMN_CODE',
            '',
        );
        const secret = this.config.get<string>(
            environment === 'SANDBOX'
                ? 'VNPAY_SANDBOX_HASH_SECRET'
                : 'VNPAY_LIVE_HASH_SECRET',
            '',
        );
        return Boolean(
            expectedCode &&
            params.vnp_TmnCode === expectedCode &&
            verifyVnpaySignature(params, secret),
        );
    }

    // Mã tham chiếu ngắn, khó đoán và không để lộ UUID nội bộ của order.
    createMerchantReference(): string {
        return randomUUID().replaceAll('-', '').toUpperCase();
    }

    // VNPay yêu cầu thời gian Việt Nam dạng yyyyMMddHHmmss, độc lập timezone của host.
    formatVnpayTimestamp(value: Date): string {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Ho_Chi_Minh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(value);
        const valueByType = Object.fromEntries(
            parts.map((part) => [part.type, part.value]),
        );
        return `${valueByType.year}${valueByType.month}${valueByType.day}${valueByType.hour}${valueByType.minute}${valueByType.second}`;
    }

    // Gửi refund theo đúng môi trường của attempt gốc, gồm cả Sandbox chạy trên production cho đồ án.
    // Request ID phải được persist trước network call để timeout không tạo lệnh mới; dữ liệu phản hồi được xác minh trước khi trả về.
    // Chỉ trả kết quả sau khi HTTP, chữ ký response, merchant, reference và số tiền đều khớp request đang xử lý.
    // Lỗi/response mơ hồ được ném lên để application giữ trạng thái chờ, tuyệt đối không tự kết luận đã hoàn.
    async refund(input: VnpayRefundInput): Promise<Record<string, string>> {
        const tmnCode = this.config.get<string>(
            input.environment === 'SANDBOX'
                ? 'VNPAY_SANDBOX_TMN_CODE'
                : 'VNPAY_LIVE_TMN_CODE',
            '',
        );
        const secret = this.config.get<string>(
            input.environment === 'SANDBOX'
                ? 'VNPAY_SANDBOX_HASH_SECRET'
                : 'VNPAY_LIVE_HASH_SECRET',
            '',
        );
        const endpoint = this.config.get<string>(
            input.environment === 'SANDBOX'
                ? 'VNPAY_SANDBOX_REFUND_URL'
                : 'VNPAY_LIVE_REFUND_URL',
            '',
        );
        if (!tmnCode || !secret || !endpoint)
            throw new ServiceUnavailableException(
                'Thiếu cấu hình API hoàn VNPay.',
            );
        const amount = Number(input.amount);
        const originalAmount = Number(input.originalAmount);
        if (
            !Number.isSafeInteger(amount) ||
            amount <= 0 ||
            !Number.isSafeInteger(originalAmount) ||
            amount > originalAmount
        )
            throw new BadRequestException('Số tiền hoàn VNPay không hợp lệ.');
        const createDate = this.formatVnpayTimestamp(new Date());
        const ipAddress = this.config.get<string>(
            'VNPAY_SERVER_IP',
            '127.0.0.1',
        );
        const info = input.orderInfo.slice(0, 255);
        const transactionType = amount === originalAmount ? '02' : '03';
        const signingData = [
            input.requestId,
            '2.1.0',
            'refund',
            tmnCode,
            transactionType,
            input.merchantReference,
            amount * 100,
            input.transactionId,
            input.transactionDate,
            input.createBy.slice(0, 245),
            createDate,
            ipAddress,
            info,
        ].join('|');
        const secureHash = createHmac('sha512', secret)
            .update(signingData)
            .digest('hex');
        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify({
                    vnp_RequestId: input.requestId,
                    vnp_Version: '2.1.0',
                    vnp_Command: 'refund',
                    vnp_TmnCode: tmnCode,
                    vnp_TransactionType: transactionType,
                    vnp_TxnRef: input.merchantReference,
                    vnp_Amount: amount * 100,
                    vnp_TransactionNo: input.transactionId,
                    vnp_TransactionDate: input.transactionDate,
                    vnp_CreateBy: input.createBy.slice(0, 245),
                    vnp_CreateDate: createDate,
                    vnp_IpAddr: ipAddress,
                    vnp_OrderInfo: info,
                    vnp_SecureHash: secureHash,
                }),
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new ServiceUnavailableException(
                'Chưa nhận được kết quả từ VNPay; yêu cầu hoàn vẫn đang chờ xác nhận.',
            );
        }
        if (!response.ok)
            throw new ServiceUnavailableException(
                'VNPay chưa xác nhận kết quả hoàn tiền.',
            );
        const body: unknown = await response.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new ServiceUnavailableException(
                'VNPay trả về dữ liệu hoàn tiền không hợp lệ.',
            );
        }
        // Chỉ chuẩn hóa scalar trước khi ký/đối chiếu; object lồng nhau không thuộc contract phản hồi VNPay.
        const normalized = Object.fromEntries(
            Object.entries(body)
                .filter(
                    ([, value]) =>
                        typeof value === 'string' || typeof value === 'number',
                )
                .map(([key, value]) => [key, String(value)]),
        );
        const responseHash = normalized.vnp_SecureHash ?? '';
        const responseFields = [
            'vnp_ResponseId',
            'vnp_Command',
            'vnp_ResponseCode',
            'vnp_Message',
            'vnp_TmnCode',
            'vnp_TxnRef',
            'vnp_Amount',
            'vnp_BankCode',
            'vnp_PayDate',
            'vnp_TransactionNo',
            'vnp_TransactionType',
            'vnp_TransactionStatus',
            'vnp_OrderInfo',
        ];
        const responseSigningData = responseFields
            .map((key) => normalized[key] ?? '')
            .join('|');
        const expectedHash = createHmac('sha512', secret)
            .update(responseSigningData)
            .digest('hex');
        if (
            !/^[a-f0-9]{128}$/i.test(responseHash) ||
            !timingSafeEqual(
                Buffer.from(responseHash, 'hex'),
                Buffer.from(expectedHash, 'hex'),
            )
        ) {
            throw new BadRequestException(
                'Chữ ký phản hồi hoàn VNPay không hợp lệ.',
            );
        }
        if (
            normalized.vnp_TmnCode !== tmnCode ||
            normalized.vnp_TxnRef !== input.merchantReference ||
            Number(normalized.vnp_Amount) !== amount * 100
        ) {
            throw new BadRequestException(
                'Phản hồi hoàn VNPay không khớp giao dịch gốc.',
            );
        }
        return normalized;
    }

    // Chỉ lấy literal IP hợp lệ và giới hạn độ dài trước khi ký request; fallback loopback tránh đưa header tùy ý vào URL.
    private normalizeIpAddress(value: string): string {
        const candidate = value.trim().split(',')[0]?.trim() ?? '';
        // isIP kiểm tra cấu trúc IPv4/IPv6 đầy đủ, không chỉ tập ký tự trông giống địa chỉ IP.
        if (!candidate || candidate.length > 45 || isIP(candidate) === 0)
            return '127.0.0.1';
        return candidate;
    }
}
