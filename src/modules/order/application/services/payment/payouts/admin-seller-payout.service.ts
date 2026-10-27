// Điều phối payout admin từ snapshot tài khoản seller tới payOS và chỉ chốt ví khi trạng thái provider xác nhận.
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type {
    AdminSellerPayoutResult,
    PayosPayout,
    PayosPayoutRequest,
} from '@/modules/order/application/types/payments/payos-payout.type';
import type { AdminWalletWithdrawalRecord } from '@/modules/order/application/types/finance/wallet-finance.type';
import { PayosPayoutService } from '@/modules/order/application/services/payment/payouts/payos-payout.service';
import { resolvePayosBankBin } from '@/modules/order/application/utils/payments/payos-bank-bin.util';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';

// Giữ orchestration payout ở application boundary; repository xử lý reserve/ledger, adapter chỉ nói chuyện payOS.
@Injectable()
export class AdminSellerPayoutService {
    // Repository giữ trạng thái/ledger, còn PayOS adapter chỉ nhận và trả dữ liệu provider.
    constructor(
        private readonly payos: PayosPayoutService,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
    ) {}

    // Trả trạng thái cấu hình và số dư Kênh Chi đã đọc từ payOS; không gửi thông tin bí mật về browser.
    async getReadiness() {
        return this.payos.getReadiness();
    }

    // Gửi một lệnh chi tới tài khoản snapshot của yêu cầu; retry luôn dùng cùng reference và idempotency key.
    // Yêu cầu REQUESTED được khóa thành PROCESSING trước khi gọi provider để webhook/trạng thái không chạy trước reserve.
    // Yêu cầu PROCESSING chỉ được gửi lại nếu mang marker payOS do luồng này tạo; PROCESSING cũ bị chặn để tránh trả trùng.
    async processWithdrawal(input: {
        withdrawalId: string;
        adminId: string;
        note?: string;
    }): Promise<AdminSellerPayoutResult> {
        const readiness = await this.payos.getReadiness();
        if (!readiness.ready || !readiness.balance)
            throw new ServiceUnavailableException(
                `Kênh Chi payOS chưa sẵn sàng: ${readiness.missing.join(', ') || 'không đọc được số dư'}.`,
            );

        const withdrawal = await this.walletRepository.getAdminWithdrawal(
            input.withdrawalId,
        );
        if (withdrawal.status === 'PAID')
            return {
                status: 'PAID',
                approvalState: 'COMPLETED',
                transactionState: 'SUCCEEDED',
            };
        if (withdrawal.status === 'FAILED')
            return {
                status: 'FAILED',
                approvalState: 'FAILED',
                transactionState: 'FAILED',
            };
        if (!['REQUESTED', 'PROCESSING'].includes(withdrawal.status))
            throw new ConflictException(
                'Yêu cầu rút hiện không thể gửi lệnh chi.',
            );

        const referenceId = this.createReferenceId(withdrawal.id);
        const transferMarker = `PAYOS:${referenceId}`;
        let payoutRequest: PayosPayoutRequest;

        if (withdrawal.status === 'REQUESTED') {
            payoutRequest = this.createPayoutRequest(withdrawal, referenceId);
            const amountCents = toCents(withdrawal.amount);
            if (amountCents > toCents(readiness.balance))
                throw new BadRequestException(
                    'Số dư Kênh Chi payOS thấp hơn số tiền yêu cầu rút.',
                );
            await this.walletRepository.prepareWithdrawalPayout({
                withdrawalId: withdrawal.id,
                adminId: input.adminId,
                transferReference: transferMarker,
                note: input.note,
            });
        } else if (withdrawal.transferReference !== transferMarker) {
            throw new ConflictException(
                'Yêu cầu này đang ở luồng chuyển khoản cũ. Hãy đối soát ngân hàng trước để tránh chuyển tiền hai lần.',
            );
        } else {
            payoutRequest = this.createPayoutRequest(withdrawal, referenceId);
        }

        const existingPayout =
            await this.payos.findPayoutByReference(referenceId);
        const payout =
            existingPayout ??
            (await this.payos.createPayout(payoutRequest, withdrawal.id));
        return this.applyProviderResult(withdrawal, payout, transferMarker);
    }

    // Đồng bộ trạng thái payOS theo mã tham chiếu đã lưu; endpoint này chỉ đọc provider và không tạo payout mới.
    async syncWithdrawal(
        withdrawalId: string,
    ): Promise<AdminSellerPayoutResult> {
        const withdrawal =
            await this.walletRepository.getAdminWithdrawal(withdrawalId);
        if (withdrawal.status === 'PAID')
            return {
                status: 'PAID',
                approvalState: 'COMPLETED',
                transactionState: 'SUCCEEDED',
            };
        if (withdrawal.status === 'FAILED')
            return {
                status: 'FAILED',
                approvalState: 'FAILED',
                transactionState: 'FAILED',
            };
        if (withdrawal.status !== 'PROCESSING')
            throw new ConflictException(
                'Yêu cầu chưa có lệnh payOS để đồng bộ trạng thái.',
            );

        const referenceId = this.createReferenceId(withdrawal.id);
        const transferMarker = `PAYOS:${referenceId}`;
        if (withdrawal.transferReference !== transferMarker)
            throw new ConflictException(
                'Yêu cầu này thuộc luồng chuyển khoản cũ và không thể tự đồng bộ qua payOS.',
            );

        const payout = await this.payos.findPayoutByReference(referenceId);
        if (!payout)
            return {
                status: 'PROCESSING',
                approvalState: 'NOT_FOUND',
                transactionState: 'NOT_FOUND',
            };
        return this.applyProviderResult(withdrawal, payout, transferMarker);
    }

    // Tạo payload chỉ từ snapshot bất biến và BIN allowlist; từ chối tài khoản không ánh xạ thay vì đoán theo tên.
    private createPayoutRequest(
        withdrawal: AdminWalletWithdrawalRecord,
        referenceId: string,
    ): PayosPayoutRequest {
        const toBin = resolvePayosBankBin(withdrawal.bankCode);
        if (!toBin)
            throw new BadRequestException(
                'Ngân hàng seller chưa có mã BIN payout; hãy cập nhật thông tin ngân hàng trước khi gửi tiền.',
            );

        const accountNumber = withdrawal.accountNumber.replace(/\D/g, '');
        if (!/^\d{6,30}$/.test(accountNumber))
            throw new BadRequestException(
                'Số tài khoản nhận trong yêu cầu rút không hợp lệ.',
            );

        const amountCents = toCents(withdrawal.amount);
        if (amountCents <= 0n || amountCents % 100n !== 0n)
            throw new BadRequestException(
                'Số tiền payout phải là số VND nguyên dương.',
            );
        const amount = Number(amountCents / 100n);
        if (!Number.isSafeInteger(amount))
            throw new BadRequestException(
                'Số tiền yêu cầu vượt giới hạn hỗ trợ của payOS.',
            );

        return {
            referenceId,
            amount,
            description: `Rut seller ${withdrawal.id.slice(0, 8)}`,
            toBin,
            toAccountNumber: accountNumber,
        };
    }

    // Rút gọn UUID nhưng giữ mã payout ổn định giữa các lần bấm và lần kiểm tra trạng thái.
    private createReferenceId(withdrawalId: string): string {
        return `withdrawal_${withdrawalId.replace(/-/g, '')}`;
    }

    // Chỉ PAID khi cả payout lẫn giao dịch ngân hàng đều thành công và mọi trường đích khớp snapshot ban đầu.
    // Trạng thái trung gian được giữ PROCESSING; trạng thái thất bại cuối cùng mới giải phóng reserve cho seller.
    private async applyProviderResult(
        withdrawal: AdminWalletWithdrawalRecord,
        payout: PayosPayout,
        transferMarker: string,
    ): Promise<AdminSellerPayoutResult> {
        const transaction = payout.transactions[0];
        const expectedBin = resolvePayosBankBin(withdrawal.bankCode);
        const expectedAccount = withdrawal.accountNumber.replace(/\D/g, '');
        const expectedAmount = Number(toCents(withdrawal.amount) / 100n);
        if (
            !transaction ||
            payout.referenceId !== this.createReferenceId(withdrawal.id) ||
            payout.transactions.length !== 1 ||
            transaction.referenceId !== payout.referenceId ||
            transaction.amount !== expectedAmount ||
            transaction.toBin !== expectedBin ||
            transaction.toAccountNumber !== expectedAccount
        )
            throw new ConflictException(
                'Dữ liệu lệnh payOS không khớp yêu cầu rút; chưa cập nhật số dư seller.',
            );

        const approvalState = payout.approvalState.toUpperCase();
        const transactionState = transaction.state.toUpperCase();
        if (
            transactionState === 'SUCCEEDED' &&
            ['COMPLETED', 'SUCCEEDED'].includes(approvalState)
        ) {
            const result =
                await this.walletRepository.reconcileWithdrawalTransfer({
                    withdrawalId: withdrawal.id,
                    amount: fromCents(toCents(withdrawal.amount)),
                    providerTransactionId: transaction.id,
                    reference: transaction.reference ?? transaction.id,
                    processedBy: 'PAYOS_API',
                });
            if (result !== 'PAID' && result !== 'DUPLICATE')
                throw new ConflictException(
                    'payOS đã báo thành công nhưng sổ ví chưa thể chốt; cần kiểm tra đối soát.',
                );
            return { status: 'PAID', approvalState, transactionState };
        }

        const terminalTransactionStates = ['FAILED', 'CANCELLED', 'REVERSED'];
        const terminalApprovalStates = ['FAILED', 'REJECTED', 'CANCELLED'];
        // Chỉ nhả tiền khi giao dịch đã kết thúc hoặc payOS từ chối trước khi xử lý; PROCESSING, ON_HOLD và trạng thái lạ vẫn giữ reserve.
        if (
            terminalTransactionStates.includes(transactionState) ||
            (terminalApprovalStates.includes(approvalState) &&
                transactionState === 'RECEIVED')
        ) {
            const failedResult =
                await this.walletRepository.failWithdrawalPayout({
                    withdrawalId: withdrawal.id,
                    providerReference: transaction.id || transferMarker,
                    note: 'PayOS xác nhận lệnh chi thất bại; tiền đã được hoàn lại vào số dư khả dụng.',
                });
            if (failedResult !== 'FAILED' && failedResult !== 'DUPLICATE')
                throw new ConflictException(
                    'PayOS báo thất bại nhưng chưa thể giải phóng khoản giữ chỗ; cần kiểm tra sổ ví.',
                );
            return { status: 'FAILED', approvalState, transactionState };
        }

        return { status: 'PROCESSING', approvalState, transactionState };
    }
}
