// Adapter HTTP của Pay2S Collection Link V2; chỉ provider adapter được biết endpoint, payload và chữ ký.
import {
    BadRequestException,
    Injectable,
    Logger,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
    createPay2sCancelSignature,
    createPay2sCreateSignature,
    verifyPay2sIpnSignature,
    verifyPay2sRedirectSignature,
} from '@/modules/order/application/utils/payments/pay2s-signature.util';
import type {
    Pay2sCancelPaymentInput,
    Pay2sCancelPaymentResult,
    Pay2sCreatePaymentInput,
    Pay2sCreatePaymentResult,
    Pay2sIpnPayload,
    Pay2sRedirectPayload,
} from '@/modules/order/application/types/payments/pay2s.types';

@Injectable()
export class Pay2sGatewayService implements OnModuleInit {
    private readonly logger = new Logger(Pay2sGatewayService.name);

    constructor(private readonly config: ConfigService) {}

    // Validate cấu hình ngay khi service khởi động; mode disabled vẫn cho phép chạy mà không cần credential Pay2S.
    onModuleInit(): void {
        if (this.config.get<string>('PAY2S_MODE', 'disabled') !== 'disabled')
            this.assertCheckoutEnabled();
    }

    // Chặn mọi call provider khi mode tắt hoặc credential thiếu; secretKey không bao giờ rời backend.
    assertCheckoutEnabled(): void {
        const mode = this.config.get<string>('PAY2S_MODE', 'disabled');
        if (mode === 'disabled')
            throw new ServiceUnavailableException(
                'Thanh toán Pay2S hiện chưa được bật.',
            );
        if (!['sandbox', 'live'].includes(mode))
            throw new ServiceUnavailableException(
                'Cấu hình Pay2S không hợp lệ.',
            );
        if (
            !this.config.get<string>('PAY2S_ACCESS_KEY', '') ||
            !this.config.get<string>('PAY2S_PARTNER_CODE', '') ||
            !this.config.get<string>('PAY2S_SECRET_KEY', '') ||
            !this.config.get<string>('PAY2S_PARTNER_NAME', '') ||
            !this.config.get<string>('PAY2S_CREATE_URL', '') ||
            !this.config.get<string>('PAY2S_CANCEL_URL', '') ||
            !this.config.get<string>('PAY2S_RETURN_URL', '') ||
            !this.config.get<string>('PAY2S_IPN_URL', '') ||
            !this.config.get<string>('PAY2S_WALLET_RETURN_URL', '') ||
            !this.config.get<string>('PAY2S_WALLET_IPN_URL', '')
        )
            throw new ServiceUnavailableException(
                'Thiếu cấu hình Pay2S cho môi trường đã chọn.',
            );
        this.getBankAccounts();
        const requireHttps = mode === 'live';
        // Khi chạy local với tài khoản live, trình duyệt của người mua vẫn có thể quay về localhost.
        // Cờ này chỉ mở ngoại lệ cho redirect browser; IPN vẫn luôn phải là HTTPS public để Pay2S gọi được.
        const allowLocalReturnUrl =
            this.config.get<string>('PAY2S_ALLOW_LOCAL_RETURN_URL', 'false') ===
                'true' &&
            this.config.get<string>('NODE_ENV', 'development') !== 'production';
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_CREATE_URL', ''),
            requireHttps,
        );
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_CANCEL_URL', ''),
            requireHttps,
        );
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_RETURN_URL', ''),
            requireHttps,
            allowLocalReturnUrl,
        );
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_IPN_URL', ''),
            requireHttps,
        );
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_WALLET_RETURN_URL', ''),
            requireHttps,
            allowLocalReturnUrl,
        );
        this.assertPublicUrl(
            this.config.get<string>('PAY2S_WALLET_IPN_URL', ''),
            requireHttps,
        );
    }

    // Tạo link V2 bằng orderId ổn định và requestId mới cho từng lần gọi; timeout không làm đổi orderId.
    async createPayment(
        input: Pay2sCreatePaymentInput,
    ): Promise<Pay2sCreatePaymentResult> {
        this.assertCheckoutEnabled();
        const accessKey = this.config.get<string>('PAY2S_ACCESS_KEY', '');
        const partnerCode = this.config.get<string>('PAY2S_PARTNER_CODE', '');
        const secretKey = this.config.get<string>('PAY2S_SECRET_KEY', '');
        const requestType = 'pay2s';
        const extraData = Buffer.from(
            JSON.stringify(input.metadata),
            'utf8',
        ).toString('base64');
        const amount = Number(input.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0)
            throw new BadRequestException('Số tiền Pay2S không hợp lệ.');
        const bankAccounts = this.getBankAccounts();
        const payload = {
            accessKey,
            partnerCode,
            partnerName: this.config.get<string>('PAY2S_PARTNER_NAME', ''),
            requestId: input.requestId,
            amount,
            orderId: input.orderId,
            orderInfo: input.orderInfo,
            orderType: requestType,
            bankAccounts,
            redirectUrl: input.redirectUrl,
            ipnUrl: input.ipnUrl,
            requestType,
            signatureVersion: '2',
            extraData,
            signature: createPay2sCreateSignature({
                accessKey,
                amount,
                extraData,
                ipnUrl: input.ipnUrl,
                orderId: input.orderId,
                orderInfo: input.orderInfo,
                partnerCode,
                redirectUrl: input.redirectUrl,
                requestId: input.requestId,
                requestType,
                secretKey,
            }),
            lang: 'vi',
        };
        const body = await this.postJson(
            this.config.get<string>('PAY2S_CREATE_URL', ''),
            payload,
            'Không nhận được phản hồi tạo link Pay2S.',
        );
        const resultCode = String(body.resultCode ?? '');
        const payUrl = typeof body.payUrl === 'string' ? body.payUrl : '';
        if (resultCode !== '0' || !payUrl)
            throw new ServiceUnavailableException(
                String(body.message ?? 'Pay2S từ chối tạo link thanh toán.'),
            );
        return {
            payUrl,
            orderInfo: String(body.orderInfo ?? input.orderInfo),
            requestId: String(body.requestId ?? input.requestId),
            response: body,
        };
    }

    // Hủy link pending best-effort; endpoint này không thực hiện hoàn tiền Pay2S.
    async cancelPayment(
        input: Pay2sCancelPaymentInput,
    ): Promise<Pay2sCancelPaymentResult> {
        this.assertCheckoutEnabled();
        const accessKey = this.config.get<string>('PAY2S_ACCESS_KEY', '');
        const partnerCode = this.config.get<string>('PAY2S_PARTNER_CODE', '');
        const requestType = 'cancel' as const;
        const payload = {
            accessKey,
            partnerCode,
            orderId: input.orderId,
            requestId: input.requestId,
            requestType,
            signature: createPay2sCancelSignature({
                accessKey,
                orderId: input.orderId,
                partnerCode,
                requestId: input.requestId,
                requestType,
                secretKey: this.config.get<string>('PAY2S_SECRET_KEY', ''),
            }),
        };
        const body = await this.postJson(
            this.config.get<string>('PAY2S_CANCEL_URL', ''),
            payload,
            'Chưa xác nhận được hủy link Pay2S.',
        );
        return {
            resultCode: String(body.resultCode ?? ''),
            status: String(body.status ?? ''),
            response: body,
        };
    }

    // Xác minh redirect theo bộ field riêng của Pay2S; redirect không được tự ghi nhận tiền vào database.
    verifyRedirect(payload: Pay2sRedirectPayload): boolean {
        return Boolean(
            payload.accessKey ===
                this.config.get<string>('PAY2S_ACCESS_KEY', '') &&
            payload.partnerCode ===
                this.config.get<string>('PAY2S_PARTNER_CODE', '') &&
            verifyPay2sRedirectSignature(
                payload,
                this.config.get<string>('PAY2S_SECRET_KEY', ''),
            ),
        );
    }

    // Xác minh IPN theo bộ field riêng và không đưa requestTrace vào canonical string.
    verifyIpn(payload: Pay2sIpnPayload): boolean {
        return Boolean(
            payload.accessKey ===
                this.config.get<string>('PAY2S_ACCESS_KEY', '') &&
            payload.partnerCode ===
                this.config.get<string>('PAY2S_PARTNER_CODE', '') &&
            verifyPay2sIpnSignature(
                payload,
                this.config.get<string>('PAY2S_SECRET_KEY', ''),
            ),
        );
    }

    // Reference của merchant không chứa UUID nội bộ thuần túy nhưng vẫn hợp lệ với giới hạn ký tự Pay2S.
    createMerchantReference(prefix = 'P2S'): string {
        return `${prefix}${randomUUID().replaceAll('-', '').toUpperCase()}`;
    }

    // Đọc bank accounts một lần ở mỗi request để thay đổi secret/config không làm payload rỗng hoặc sai kiểu.
    private getBankAccounts(): Array<{
        account_number: string;
        bank_id: string;
    }> {
        const raw = this.config.get<string>('PAY2S_BANK_ACCOUNTS_JSON', '');
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new ServiceUnavailableException(
                'PAY2S_BANK_ACCOUNTS_JSON không phải JSON hợp lệ.',
            );
        }
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10)
            throw new ServiceUnavailableException(
                'Pay2S cần từ 1 đến 10 tài khoản ngân hàng.',
            );
        const accounts = parsed.map((item) => {
            if (
                !item ||
                typeof item !== 'object' ||
                typeof (item as { account_number?: unknown }).account_number !==
                    'string' ||
                typeof (item as { bank_id?: unknown }).bank_id !== 'string' ||
                !(item as { account_number: string }).account_number.trim() ||
                !(item as { bank_id: string }).bank_id.trim()
            )
                throw new ServiceUnavailableException(
                    'Cấu hình tài khoản ngân hàng Pay2S không hợp lệ.',
                );
            return {
                account_number: (item as { account_number: string })
                    .account_number,
                bank_id: (item as { bank_id: string }).bank_id,
            };
        });
        return accounts;
    }

    // Chỉ chấp nhận URL HTTP(S); live chặn hostname local/private, ngoại trừ redirect localhost khi bật cờ local rõ ràng.
    private assertPublicUrl(
        value: string,
        requireHttps: boolean,
        allowLocalHttp = false,
    ): void {
        try {
            const url = new URL(value);
            const isLocalHttp =
                allowLocalHttp &&
                url.protocol === 'http:' &&
                this.isLoopbackHostname(url.hostname);
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                (requireHttps && url.protocol !== 'https:' && !isLocalHttp) ||
                (requireHttps &&
                    this.isPrivateHostname(url.hostname) &&
                    !isLocalHttp)
            )
                throw new Error();
        } catch {
            throw new ServiceUnavailableException(
                'Cấu hình URL callback Pay2S không hợp lệ.',
            );
        }
    }

    // Chỉ nhận loopback rõ ràng cho redirect của browser, không mở rộng ngoại lệ cho mọi IP private trong mạng LAN.
    private isLoopbackHostname(hostname: string): boolean {
        const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return (
            normalized === 'localhost' ||
            normalized === '127.0.0.1' ||
            normalized === '::1'
        );
    }

    // Chặn các địa chỉ chỉ tồn tại trong mạng nội bộ; việc kiểm tra reachability thực tế vẫn cần smoke test môi trường.
    private isPrivateHostname(hostname: string): boolean {
        const normalized = hostname.toLowerCase();
        if (
            normalized === 'localhost' ||
            normalized.endsWith('.localhost') ||
            normalized.endsWith('.local')
        )
            return true;
        const octets = normalized.split('.').map(Number);
        if (
            octets.length !== 4 ||
            octets.some(
                (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
            )
        )
            return false;
        const first = octets[0] ?? -1;
        const second = octets[1] ?? -1;
        return (
            first === 10 ||
            first === 127 ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168)
        );
    }

    // Gửi JSON tới Pay2S và chỉ trả object hợp lệ để tầng nghiệp vụ không dùng phản hồi lỗi làm payUrl.
    // Khi fetch lỗi, ghi loại lỗi và hostname để phân biệt DNS/TLS/timeout mà không in payload có khóa.
    // Khi Pay2S trả HTTP lỗi hoặc body rỗng/sai JSON, chỉ log status, content type và message đã parse;
    // không log raw response vì provider/proxy có thể phản chiếu dữ liệu giao dịch hoặc nội dung ngoài kiểm soát.
    // Phía client vẫn nhận thông báo chung để không lộ cấu hình nội bộ; log server giữ đủ tín hiệu chẩn đoán.
    private async postJson(
        endpoint: string,
        payload: Record<string, unknown>,
        errorMessage: string,
    ): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json; charset=UTF-8',
                    accept: 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(
                    Number(
                        this.config.get<string>(
                            'PAY2S_REQUEST_TIMEOUT_MS',
                            '10000',
                        ),
                    ),
                ),
            });
        } catch (error: unknown) {
            const hostname = new URL(endpoint).hostname;
            const errorName =
                error instanceof Error ? error.name : 'UnknownError';
            this.logger.warn(
                `Pay2S request failed: host=${hostname}, error=${errorName}`,
            );
            throw new ServiceUnavailableException(errorMessage);
        }

        const responseText = await response.text().catch(() => '');
        let body: unknown = null;
        try {
            body = responseText ? JSON.parse(responseText) : null;
        } catch {
            // Giữ body rỗng khi provider trả HTML/text để nhánh lỗi ghi nhận content type thay vì log nội dung.
        }
        if (
            !response.ok ||
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body)
        ) {
            const providerMessage =
                body && typeof body === 'object' && 'message' in body
                    ? String((body as { message?: unknown }).message ?? '')
                    : '';
            const contentType =
                response.headers.get('content-type') ?? 'unknown';
            const diagnostic = [
                `Pay2S invalid response: host=${new URL(endpoint).hostname}`,
                `status=${response.status}`,
                `contentType=${contentType}`,
                `bodyBytes=${Buffer.byteLength(responseText)}`,
                `message=${providerMessage.slice(0, 240) || 'none'}`,
            ].join(', ');
            this.logger.warn(diagnostic);
            throw new ServiceUnavailableException(errorMessage);
        }
        return body as Record<string, unknown>;
    }
}
