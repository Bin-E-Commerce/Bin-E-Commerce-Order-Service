// Đối soát giao dịch tiền ra Pay2S; không khởi tạo lệnh chuyển tiền hoặc tự xác nhận người nhận.
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
import type { Pay2sBankTransaction } from '@/modules/order/application/types/payments/pay2s-payout.type';
import { findWithdrawalTransferLookupInMemo } from '@/modules/order/application/utils/payments/withdrawal-transfer-memo.util';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';

// Nhận OUT từ nguồn Pay2S đã liên kết và lưu candidate để admin đối chiếu thủ công tài khoản thụ hưởng.
@Injectable()
export class Pay2sPayoutReconciliationService {
    private readonly logger = new Logger(Pay2sPayoutReconciliationService.name);

    constructor(
        private readonly config: ConfigService,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
    ) {}

    // Báo cấu hình tối thiểu cho admin mà không trả token hoặc tài khoản nguồn.
    // Tài khoản nguồn là số tài khoản ngân hàng, còn mã giao dịch Pay2S được chuẩn hóa riêng trong payload.
    // Thiếu token hoặc tài khoản nguồn hợp lệ thì khóa payout để không tạo giao dịch không thể đối soát.
    getReadiness(): {
        ready: boolean;
        missing: Array<'WEBHOOK_TOKEN' | 'SOURCE_ACCOUNT_NUMBER'>;
    } {
        const missing: Array<'WEBHOOK_TOKEN' | 'SOURCE_ACCOUNT_NUMBER'> = [];
        if (!this.config.get<string>('PAY2S_PAYOUT_WEBHOOK_TOKEN', '').trim())
            missing.push('WEBHOOK_TOKEN');
        const sourceAccount = this.config
            .get<string>('PAY2S_PAYOUT_SOURCE_ACCOUNT_NUMBER', '')
            .trim();
        const normalizedSourceAccount =
            this.normalizeAccountNumber(sourceAccount);
        // Bỏ khoảng trắng/gạch nối trước đó nhưng không cho chữ cái lọt vào cấu hình số tài khoản ngân hàng.
        if (!/^\d{6,64}$/.test(normalizedSourceAccount))
            missing.push('SOURCE_ACCOUNT_NUMBER');
        return { ready: missing.length === 0, missing };
    }

    // Xác thực bearer token trước khi parse event; callback hợp lệ nhưng không khớp payout được ACK để tránh retry vô hạn.
    // Pay2S có thể gửi một giao dịch hoặc batch nên mỗi entry được stage độc lập và theo thứ tự nhận.
    async processWebhook(
        authorization: string | undefined,
        payload: unknown,
    ): Promise<{ success: true }> {
        const expectedToken = this.config
            .get<string>('PAY2S_PAYOUT_WEBHOOK_TOKEN', '')
            .trim();
        const sourceAccountNumber = this.normalizeAccountNumber(
            this.config.get<string>('PAY2S_PAYOUT_SOURCE_ACCOUNT_NUMBER', ''),
        );
        if (!this.getReadiness().ready)
            throw new ServiceUnavailableException(
                'Webhook payout Pay2S chưa được cấu hình.',
            );
        if (!this.matchesBearerToken(authorization, expectedToken))
            throw new UnauthorizedException(
                'Token webhook Pay2S không hợp lệ.',
            );

        const transactions = this.readTransactions(payload);
        for (const transaction of transactions)
            await this.stageTransaction(transaction, sourceAccountNumber);
        return { success: true };
    }

    // Chỉ event OUT từ đúng tài khoản nguồn, có ID giao dịch, số tiền hợp lệ và memo payout cũ/mới mới được stage.
    // UUID đầy đủ giữ tương thích lịch sử; memo code ngắn được tra qua cột duy nhất để không cắt hoặc đoán payout ID.
    // Candidate vẫn chờ admin kiểm tra tài khoản nhận vì webhook Pay2S không xác thực được người thụ hưởng.
    private async stageTransaction(
        transaction: Pay2sBankTransaction,
        sourceAccountNumber: string,
    ): Promise<void> {
        if (this.readText(transaction.transferType)?.toUpperCase() !== 'OUT')
            return;

        const eventId =
            this.readText(transaction.id) ??
            this.readText(transaction.transactionNumber);
        const eventAccount = this.normalizeAccountNumber(
            this.readText(transaction.accountNumber) ?? '',
        );
        if (eventAccount !== sourceAccountNumber) {
            this.logIgnored(eventId ?? 'unknown', 'source_account_mismatch');
            return;
        }

        const withdrawalLookup = findWithdrawalTransferLookupInMemo(
            transaction.content,
        );
        if (!withdrawalLookup || !eventId) {
            this.logIgnored(eventId ?? 'unknown', 'memo_or_event_id_missing');
            return;
        }

        const amount = this.readMoney(transaction.transferAmount);
        if (eventId.length > 120 || amount === null) {
            this.logIgnored(eventId, 'transaction_fields_invalid');
            return;
        }

        const transactionNumber = this.readText(transaction.transactionNumber);
        const result = await this.walletRepository.stagePay2sWithdrawalTransfer(
            {
                ...withdrawalLookup,
                amount,
                providerTransactionId: eventId,
                transactionNumber:
                    transactionNumber && transactionNumber.length <= 120
                        ? transactionNumber
                        : null,
            },
        );
        if (result !== 'STAGED' && result !== 'DUPLICATE')
            this.logIgnored(eventId, result.toLowerCase());
    }

    // Chấp nhận event đơn hoặc wrapper transactions của webhook batch; giới hạn batch để tránh callback phình bất thường.
    private readTransactions(payload: unknown): Pay2sBankTransaction[] {
        if (Array.isArray(payload)) {
            if (payload.length > 100 || !payload.every(this.isTransaction))
                throw new BadRequestException(
                    'Danh sách giao dịch webhook Pay2S không hợp lệ.',
                );
            return payload as Pay2sBankTransaction[];
        }
        if (typeof payload !== 'object' || payload === null)
            throw new BadRequestException(
                'Payload webhook Pay2S không hợp lệ.',
            );

        const wrapped = (payload as { transactions?: unknown }).transactions;
        if (wrapped !== undefined) {
            if (
                !Array.isArray(wrapped) ||
                wrapped.length > 100 ||
                !wrapped.every(this.isTransaction)
            )
                throw new BadRequestException(
                    'Danh sách giao dịch webhook Pay2S không hợp lệ.',
                );
            return wrapped as Pay2sBankTransaction[];
        }
        if (!this.isTransaction(payload))
            throw new BadRequestException(
                'Giao dịch webhook Pay2S không hợp lệ.',
            );
        return [payload as Pay2sBankTransaction];
    }

    // Runtime guard ngăn object lồng hoặc primitive lọt vào xử lý field bên ngoài.
    private isTransaction(value: unknown): value is Pay2sBankTransaction {
        return (
            typeof value === 'object' && value !== null && !Array.isArray(value)
        );
    }

    // Bearer token được so sánh constant-time sau khi scheme và độ dài đã hợp lệ.
    private matchesBearerToken(
        authorization: string | undefined,
        expectedToken: string,
    ): boolean {
        const providedToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        if (!providedToken) return false;
        const expected = Buffer.from(expectedToken, 'utf8');
        const provided = Buffer.from(providedToken.trim(), 'utf8');
        return (
            expected.length === provided.length &&
            timingSafeEqual(expected, provided)
        );
    }

    // Chuẩn hóa tài khoản ngân hàng và mã Pay2S bằng chữ hoa, giữ nguyên tiền tố chữ và số 0 đầu.
    // Chỉ bỏ khoảng trắng/gạch nối để payload có định dạng trình bày khác vẫn khớp cùng một định danh.
    private normalizeAccountNumber(value: string): string {
        return value.trim().replace(/[\s-]/g, '').toUpperCase();
    }

    // Provider có thể trả số hoặc chuỗi; object và chuỗi rỗng không được dùng làm khóa đối soát.
    private readText(value: unknown): string | null {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        if (typeof value === 'number' && !Number.isSafeInteger(value))
            return null;
        const normalized = String(value).trim();
        return normalized || null;
    }

    // Quy VND về cents để so sánh chính xác; từ chối số thực không an toàn và amount sai định dạng.
    private readMoney(value: unknown): string | null {
        if (
            typeof value !== 'string' &&
            (typeof value !== 'number' || !Number.isSafeInteger(value))
        )
            return null;
        const normalized = String(value).trim();
        if (!/^\d{1,12}(\.\d{1,2})?$/.test(normalized)) return null;
        try {
            return fromCents(toCents(normalized));
        } catch {
            return null;
        }
    }

    // Log ID event và lý do bỏ qua, không ghi token, số tài khoản hoặc nội dung chuyển tiền.
    private logIgnored(eventId: string, reason: string): void {
        this.logger.warn(
            JSON.stringify({
                event: 'pay2s_payout_webhook_ignored',
                eventId,
                reason,
            }),
        );
    }
}
