// Adapter gọi Kênh Chi payOS; dịch vụ này chỉ giữ thông tin provider và không thay đổi sổ ví seller.
import {
    BadGatewayException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    createPayosPayoutSignature,
    verifyPayosPayoutSignature,
} from '@/modules/order/application/utils/payments/payos-payout-signature.util';
import type {
    PayosPayout,
    PayosPayoutReadiness,
    PayosPayoutRequest,
} from '@/modules/order/application/types/payments/payos-payout.type';

interface PayosCredentials {
    clientId: string;
    apiKey: string;
    checksumKey: string;
}

// Gọi các endpoint payOS cần cho luồng chi hộ mà không để lộ khóa bí mật qua response hoặc log.
@Injectable()
export class PayosPayoutService {
    private readonly baseUrl = 'https://api-merchant.payos.vn';
    private readonly timeoutMs = 10_000;

    // Cấu hình chỉ được đọc ở backend để browser không thể truy cập khóa chi hộ.
    constructor(private readonly config: ConfigService) {}

    // Kiểm tra đủ ba khóa riêng của Kênh Chi rồi đọc số dư thật để admin không gửi lệnh khi chưa có nguồn tiền.
    // Lỗi kết nối được trả thành lỗi service để nút không coi cấu hình chưa xác minh là sẵn sàng.
    async getReadiness(): Promise<PayosPayoutReadiness> {
        const credentials = this.getCredentials();
        const missing: PayosPayoutReadiness['missing'] = [];
        if (!credentials.clientId) missing.push('CLIENT_ID');
        if (!credentials.apiKey) missing.push('API_KEY');
        if (!credentials.checksumKey) missing.push('CHECKSUM_KEY');
        if (missing.length) return { ready: false, missing, balance: null };

        const data = await this.requestData(
            'GET',
            '/v1/payouts-account/balance',
            undefined,
            undefined,
            credentials,
        );
        const balance = this.readText(this.asRecord(data).balance);
        if (!balance || !/^\d+(\.\d{1,2})?$/.test(balance))
            throw new BadGatewayException(
                'PayOS trả số dư Kênh Chi không hợp lệ.',
            );

        return { ready: true, missing: [], balance };
    }

    // Gửi lại đúng payload với idempotency key cố định của yêu cầu rút để bấm lại sau lỗi mạng không tạo chi trùng.
    async createPayout(
        payout: PayosPayoutRequest,
        idempotencyKey: string,
    ): Promise<PayosPayout> {
        const data = await this.requestData(
            'POST',
            '/v1/payouts/',
            payout as unknown as Record<string, unknown>,
            idempotencyKey,
        );
        return this.readPayout(data);
    }

    // Tìm đúng payout theo referenceId ổn định trước khi retry, tránh tạo giao dịch mới khi payOS đã nhận lệnh.
    async findPayoutByReference(
        referenceId: string,
    ): Promise<PayosPayout | null> {
        const query = new URLSearchParams({
            referenceId,
            limit: '10',
            offset: '0',
        });
        const data = await this.requestData(
            'GET',
            `/v1/payouts?${query.toString()}`,
        );
        const payouts = this.readCollection(this.asRecord(data).payouts).map(
            (item) => this.readPayout(item),
        );
        const matchingPayouts = payouts.filter(
            (payout) => payout.referenceId === referenceId,
        );
        if (matchingPayouts.length > 1)
            throw new BadGatewayException(
                'PayOS trả nhiều lệnh cùng mã tham chiếu; cần kiểm tra thủ công.',
            );
        return matchingPayouts[0] ?? null;
    }

    // Đọc credentials tại runtime để hỗ trợ cập nhật cấu hình không cần đóng gói lại ứng dụng.
    private getCredentials(): PayosCredentials {
        return {
            clientId: this.config
                .get<string>('PAYOS_PAYOUT_CLIENT_ID', '')
                .trim(),
            apiKey: this.config.get<string>('PAYOS_PAYOUT_API_KEY', '').trim(),
            checksumKey: this.config
                .get<string>('PAYOS_PAYOUT_CHECKSUM_KEY', '')
                .trim(),
        };
    }

    // Gọi HTTPS payOS, ký body payout và xác minh chữ ký response nếu provider trả header x-signature.
    // Timeout hoặc phản hồi không rõ giữ nguyên yêu cầu ở PROCESSING để lần kiểm tra sau tra theo cùng reference.
    private async requestData(
        method: 'GET' | 'POST',
        path: string,
        body?: Record<string, unknown>,
        idempotencyKey?: string,
        credentials = this.getCredentials(),
    ): Promise<unknown> {
        const headers: Record<string, string> = {
            'x-client-id': credentials.clientId,
            'x-api-key': credentials.apiKey,
            'content-type': 'application/json',
        };
        if (body) {
            headers['x-signature'] = createPayosPayoutSignature(
                credentials.checksumKey,
                body,
            );
        }
        if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            throw new ServiceUnavailableException(
                'Chưa xác định được kết quả từ payOS. Yêu cầu vẫn được giữ để kiểm tra lại an toàn.',
            );
        }

        let envelope: Record<string, unknown>;
        try {
            envelope = this.asRecord(await response.json());
        } catch {
            throw new ServiceUnavailableException(
                'PayOS chưa trả kết quả hợp lệ; yêu cầu vẫn được giữ để kiểm tra lại.',
            );
        }
        if (!response.ok || envelope.code !== '00' || !envelope.data)
            throw new BadGatewayException(
                'PayOS chưa xác nhận lệnh chi. Hãy kiểm tra lại trạng thái trước khi xử lý tiếp.',
            );

        const signature = response.headers.get('x-signature');
        const data = this.asRecord(envelope.data);
        if (
            signature &&
            !verifyPayosPayoutSignature(
                credentials.checksumKey,
                data,
                signature,
            )
        )
            throw new BadGatewayException(
                'Chữ ký phản hồi payOS không hợp lệ; không cập nhật trạng thái payout.',
            );
        return envelope.data;
    }

    // Chuẩn hóa danh sách khi API hoặc tài liệu trả array hay object đánh chỉ số, đồng thời bỏ mọi phần tử sai kiểu.
    private readCollection(value: unknown): unknown[] {
        if (Array.isArray(value)) return value;
        if (typeof value !== 'object' || value === null) return [];
        return Object.values(value);
    }

    // Kiểm tra response payout ở ranh giới provider trước khi application service so sánh amount và tài khoản đích.
    private readPayout(value: unknown): PayosPayout {
        const record = this.asRecord(value);
        const id = this.readText(record.id);
        const referenceId = this.readText(record.referenceId);
        const approvalState = this.readText(record.approvalState);
        const transactions = this.readCollection(record.transactions).map(
            (item) => this.readPayoutTransaction(item),
        );
        if (!id || !referenceId || !approvalState || !transactions.length)
            throw new BadGatewayException(
                'Dữ liệu lệnh chi payOS không đầy đủ; không thể chốt payout.',
            );
        return { id, referenceId, approvalState, transactions };
    }

    // Giữ các trường tiền, tài khoản và trạng thái cần xác minh; không đưa raw response provider vào ledger.
    private readPayoutTransaction(value: unknown) {
        const record = this.asRecord(value);
        const id = this.readText(record.id);
        const referenceId = this.readText(record.referenceId);
        const toBin = this.readText(record.toBin);
        const toAccountNumber = this.readText(record.toAccountNumber);
        const state = this.readText(record.state);
        const amount = record.amount;
        if (
            !id ||
            !referenceId ||
            !toBin ||
            !toAccountNumber ||
            !state ||
            typeof amount !== 'number' ||
            !Number.isSafeInteger(amount)
        )
            throw new BadGatewayException(
                'Thông tin giao dịch payOS không đầy đủ; không thể chốt payout.',
            );
        return {
            id,
            referenceId,
            amount,
            toBin,
            toAccountNumber,
            toAccountName: this.readText(record.toAccountName),
            reference: this.readText(record.reference),
            errorCode: this.readText(record.errorCode),
            errorMessage: this.readText(record.errorMessage),
            state,
        };
    }

    // Ép dữ liệu provider thành object record để tránh truy cập thuộc tính trên null, array hoặc primitive.
    private asRecord(value: unknown): Record<string, unknown> {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return {};
        return value as Record<string, unknown>;
    }

    // Provider có thể trả text/null; chỉ giữ chuỗi đã trim để kiểm tra mã và trạng thái.
    private readText(value: unknown): string | null {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const normalized = String(value).trim();
        return normalized || null;
    }
}
