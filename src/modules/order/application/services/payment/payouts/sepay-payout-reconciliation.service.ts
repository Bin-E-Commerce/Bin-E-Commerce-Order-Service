// Nhận webhook tiền ra từ SePay và đối soát payout; không khởi tạo lệnh chuyển tiền ngân hàng.
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SepayBankTransaction } from '@/modules/order/application/types/payments/sepay-payout.type';
import { findWithdrawalIdInTransferMemo } from '@/modules/order/application/utils/payments/withdrawal-transfer-memo.util';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';

// Xác thực webhook OUT của SePay và đối chiếu giao dịch với payout đang chờ.
// Service không gọi API chuyển tiền; việc chuyển khoản thật do admin thực hiện ngoài hệ thống.
@Injectable()
export class SepayPayoutReconciliationService {
    private readonly logger = new Logger(SepayPayoutReconciliationService.name);

    constructor(
        private readonly config: ConfigService,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
    ) {}

    // Báo điều kiện đối soát tiền ra cho admin mà không trả API Key hoặc số tài khoản nguồn.
    // Thiếu một trong hai cấu hình thì webhook không thể chốt payout, nên không cho mở bước chuyển khoản.
    getReadiness(): {
        ready: boolean;
        missing: Array<'WEBHOOK_API_KEY' | 'SOURCE_ACCOUNT_NUMBER'>;
    } {
        const missing: Array<'WEBHOOK_API_KEY' | 'SOURCE_ACCOUNT_NUMBER'> = [];
        if (!this.config.get<string>('SEPAY_PAYOUT_WEBHOOK_API_KEY', '').trim())
            missing.push('WEBHOOK_API_KEY');
        const sourceAccount = this.config
            .get<string>('SEPAY_PAYOUT_SOURCE_ACCOUNT_NUMBER', '')
            .trim();
        if (!/^\d{6,30}$/.test(sourceAccount))
            missing.push('SOURCE_ACCOUNT_NUMBER');
        return { ready: missing.length === 0, missing };
    }

    // Xác thực API Key trước khi đọc giao dịch và yêu cầu số tài khoản nguồn để callback giả không thể ghi sổ.
    // Payload SePay là một giao dịch; callback hợp lệ nhưng không liên quan được ACK để tránh retry vô ích.
    // Chỉ lỗi cấu hình, xác thực hoặc lưu dữ liệu mới trả lỗi cho SePay gửi lại.
    async processWebhook(
        authorization: string | undefined,
        payload: unknown,
    ): Promise<{ success: true }> {
        const expectedApiKey = this.config
            .get<string>('SEPAY_PAYOUT_WEBHOOK_API_KEY', '')
            .trim();
        const sourceAccountNumber = this.normalizeAccountNumber(
            this.config.get<string>('SEPAY_PAYOUT_SOURCE_ACCOUNT_NUMBER', ''),
        );
        if (!this.getReadiness().ready)
            throw new ServiceUnavailableException(
                'Webhook payout SePay chưa được cấu hình.',
            );
        if (!this.matchesApiKey(authorization, expectedApiKey))
            throw new UnauthorizedException(
                'API Key webhook SePay không hợp lệ.',
            );

        const transaction = this.readTransaction(payload);
        await this.reconcileTransaction(transaction, sourceAccountNumber);
        return { success: true };
    }

    // Chỉ xử lý giao dịch OUT từ tài khoản nền tảng; memo UUID, số tiền và mã tham chiếu phải khớp yêu cầu đang PROCESSING.
    // Repository khóa payout và ví trong cùng transaction, nên webhook SePay gửi lặp không thể ghi chi hai lần.
    private async reconcileTransaction(
        transaction: SepayBankTransaction,
        sourceAccountNumber: string,
    ): Promise<void> {
        if (this.readText(transaction.transferType)?.toLowerCase() !== 'out')
            return;

        const eventId =
            this.readText(transaction.id) ??
            this.readText(transaction.referenceCode) ??
            'unknown';
        const eventAccount = this.normalizeAccountNumber(
            this.readText(transaction.accountNumber) ?? '',
        );
        if (eventAccount !== sourceAccountNumber) {
            this.logIgnored(eventId, 'source_account_mismatch');
            return;
        }

        const withdrawalId =
            findWithdrawalIdInTransferMemo(transaction.content) ??
            findWithdrawalIdInTransferMemo(transaction.code);
        if (!withdrawalId) {
            this.logIgnored(eventId, 'withdrawal_memo_missing');
            return;
        }

        // SePay quy định dùng ID giao dịch để khử trùng lặp; referenceCode chỉ phục vụ tra cứu ngân hàng.
        const providerTransactionId = this.readText(transaction.id);
        const reference =
            this.readText(transaction.referenceCode) ?? providerTransactionId;
        const amount = this.readMoney(transaction.transferAmount);
        if (
            !providerTransactionId ||
            providerTransactionId.length > 120 ||
            !reference ||
            reference.length > 120 ||
            amount === null
        ) {
            this.logIgnored(eventId, 'transaction_fields_invalid');
            return;
        }

        const result = await this.walletRepository.reconcileWithdrawalTransfer({
            withdrawalId,
            amount,
            providerTransactionId,
            reference,
        });
        if (result !== 'PAID' && result !== 'DUPLICATE')
            this.logIgnored(eventId, result.toLowerCase());
    }

    // Webhook SePay gửi một object JSON; từ chối array và payload rỗng để provider retry khi giao thức bị cấu hình sai.
    private readTransaction(payload: unknown): SepayBankTransaction {
        if (
            typeof payload !== 'object' ||
            payload === null ||
            Array.isArray(payload)
        )
            throw new BadRequestException(
                'Payload webhook SePay không hợp lệ.',
            );
        return payload as SepayBankTransaction;
    }

    // SePay đặt API Key theo dạng "Apikey <secret>"; so sánh constant-time sau khi kiểm tra scheme và độ dài.
    private matchesApiKey(
        authorization: string | undefined,
        expectedApiKey: string,
    ): boolean {
        const providedApiKey = authorization?.match(/^Apikey\s+(.+)$/i)?.[1];
        if (!providedApiKey) return false;
        const expected = Buffer.from(expectedApiKey, 'utf8');
        const provided = Buffer.from(providedApiKey.trim(), 'utf8');
        return (
            expected.length === provided.length &&
            timingSafeEqual(expected, provided)
        );
    }

    // Chỉ so sánh chữ số để giữ số 0 đầu và bỏ dấu phân cách ngân hàng có thể thêm.
    private normalizeAccountNumber(value: string): string {
        return value.replace(/\D/g, '');
    }

    // Trường provider có thể là số hoặc chuỗi; không ép object hay giá trị rỗng thành reference.
    private readText(value: unknown): string | null {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const normalized = String(value).trim();
        return normalized || null;
    }

    // Quy tiền VND về cents để so sánh chính xác; từ chối số thực không an toàn và dữ liệu âm/sai định dạng.
    private readMoney(value: unknown): string | null {
        if (
            typeof value !== 'string' &&
            (typeof value !== 'number' || !Number.isSafeInteger(value))
        )
            return null;
        try {
            return fromCents(toCents(String(value)));
        } catch {
            return null;
        }
    }

    // Chỉ ghi mã giao dịch và lý do bỏ qua; không log API Key, số tài khoản hoặc nội dung chuyển khoản.
    private logIgnored(eventId: string, reason: string): void {
        this.logger.warn(
            JSON.stringify({
                event: 'sepay_payout_webhook_ignored',
                eventId,
                reason,
            }),
        );
    }
}
