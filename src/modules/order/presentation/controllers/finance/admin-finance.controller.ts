// Controller finance admin giới hạn quyền payout và chuyển nghiệp vụ chi hộ vào application service.
import {
    Body,
    BadRequestException,
    ConflictException,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import { Pay2sPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/pay2s-payout-reconciliation.service';
import { ConfirmCodRemittanceDto } from '@/modules/order/presentation/dto/finance/confirm-cod-remittance.dto';
import { ConfirmCodRefundDto } from '@/modules/order/presentation/dto/finance/confirm-cod-refund.dto';
import { Inject } from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import {
    AdminWalletWithdrawalActionDto,
    CreateFinanceSettlementBatchDto,
} from '@/modules/order/presentation/dto/finance/wallet-finance.dto';

// Route quản lý dòng tiền; payout chỉ được ghi nhận sau webhook Pay2S và xác nhận người nhận của admin.
@Controller({ path: 'admin/finance', version: '1' })
export class AdminFinanceController {
    constructor(
        private readonly paymentService: PaymentService,
        private readonly payoutReconciliation: Pay2sPayoutReconciliationService,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
    ) {}

    // Trả trạng thái cấu hình webhook Pay2S mà không làm lộ token hoặc tài khoản nguồn.
    @Get('payout-readiness')
    async getPayoutReadiness(
        @Headers('x-user-permissions') permissionsHeader: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        return this.payoutReconciliation.getReadiness();
    }

    // Admin overview tổng hợp số dư mô phỏng và trang ledger; không chứa thông tin ngân hàng thô.
    @Get('overview')
    async getOverview(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.read');
        return this.walletRepository.getAdminFinance(
            this.toBoundedInteger(pageValue, 1, 1, 1_000_000),
            this.toBoundedInteger(pageSizeValue, 20, 1, 100),
        );
    }

    // Ledger hiển thị tất cả dòng tiền giả lập, phân trang và không lộ số tài khoản seller.
    @Get('ledger')
    async getLedger(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.read');
        return this.walletRepository.getPlatformLedger(
            this.toBoundedInteger(pageValue, 1, 1, 1_000_000),
            this.toBoundedInteger(pageSizeValue, 50, 1, 100),
        );
    }

    // Danh sách payout chỉ hiện số tài khoản đã che; nội dung đầy đủ nằm ở route detail có permission riêng.
    @Get('withdrawals')
    async getWithdrawals(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
        @Query('status') status?: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.read');
        return this.walletRepository.listAdminWithdrawals(
            this.toBoundedInteger(pageValue, 1, 1, 1_000_000),
            this.toBoundedInteger(pageSizeValue, 20, 1, 100),
            status,
        );
    }

    // Trả các đơn COD đã hoàn tất nhưng chưa remittance; trang admin chỉ nhận dữ liệu cần để đối soát và không đọc hồ sơ khách.
    @Get('cod-remittances')
    async getPendingCodRemittances(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.read');
        return this.walletRepository.listPendingCodRemittances(
            this.toBoundedInteger(pageValue, 1, 1, 1_000_000),
            this.toBoundedInteger(pageSizeValue, 20, 1, 100),
        );
    }

    // Trả tài khoản seller và memo đối soát chỉ khi admin có quyền payout; số tài khoản không xuất hiện ở danh sách.
    @Get('withdrawals/:withdrawalId')
    async getWithdrawal(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        return this.walletRepository.getAdminWithdrawal(withdrawalId);
    }

    // Chỉ mở bước chuyển thủ công khi Pay2S đã sẵn sàng nhận webhook và admin xác nhận đã kiểm tra thông tin nhận.
    @Post('withdrawals/:withdrawalId/processing')
    async markWithdrawalProcessing(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        if (!this.payoutReconciliation.getReadiness().ready)
            throw new ServiceUnavailableException(
                'Webhook tiền ra Pay2S chưa được cấu hình đầy đủ.',
            );
        if (dto.manualTransferAcknowledged !== true)
            throw new BadRequestException(
                'Cần xác nhận sẽ chuyển tiền qua ứng dụng ngân hàng.',
            );
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'PROCESSING',
            note: dto.note,
        });
        return { updated: true };
    }

    // Chỉ ghi nhận PAID khi đã có event OUT khớp amount và admin xác nhận người nhận đúng tài khoản seller.
    @Post('withdrawals/:withdrawalId/transfer-confirmation')
    async confirmWithdrawalTransfer(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        if (dto.recipientConfirmed !== true)
            throw new BadRequestException(
                'Cần xác nhận đã đối chiếu đúng tài khoản nhận của seller.',
            );
        const result =
            await this.walletRepository.confirmPay2sWithdrawalTransfer({
                withdrawalId,
                adminId,
                note: dto.note,
            });
        if (result === 'TRANSFER_NOT_DETECTED')
            throw new ConflictException(
                'Pay2S chưa nhận diện giao dịch tiền ra khớp yêu cầu này.',
            );
        if (result === 'NOT_PROCESSING')
            throw new ConflictException(
                'Yêu cầu rút không còn ở trạng thái có thể xác nhận.',
            );
        if (result === 'NOT_FOUND')
            throw new BadRequestException('Không tìm thấy yêu cầu rút tiền.');
        return { status: result };
    }

    // Chỉ từ chối khi chưa bắt đầu chuyển khoản; sau đó phải chờ webhook để tránh nhả tiền trong lúc bank callback trễ.
    @Post('withdrawals/:withdrawalId/reject')
    async rejectWithdrawal(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        // Từ chối phải có lý do rõ ràng; chuẩn hóa trước khi ghi để không lưu chuỗi chỉ gồm khoảng trắng.
        if (!dto.note?.trim())
            throw new BadRequestException(
                'Cần nhập lý do từ chối yêu cầu rút tiền.',
            );
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'REJECTED',
            note: dto.note.trim(),
        });
        return { updated: true };
    }

    // Tạo đợt đối soát chỉ gắn nhãn các giao dịch; nó không trì hoãn cộng ví hoặc yêu cầu rút.
    @Post('settlement-batches')
    async createSettlementBatch(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Body() dto: CreateFinanceSettlementBatchDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.reconcile');
        return this.walletRepository.createSettlementBatch({
            adminId,
            note: dto.note,
            ledgerIds: dto.ledgerIds,
        });
    }

    // Chốt kiểm tra của một đợt; bản ghi ledger tiếp tục giữ nguyên để audit.
    @Post('settlement-batches/:batchId/reconcile')
    async reconcileSettlementBatch(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('batchId', new ParseUUIDPipe()) batchId: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.reconcile');
        await this.walletRepository.reconcileSettlementBatch({
            batchId,
            adminId,
        });
        return { reconciled: true };
    }

    // Lưu mã giao dịch và chỉ mở credit ví sau khi order hoàn tất, COD đã được khách trả.
    @Post('cod-remittances/:orderId/confirmation')
    async confirmCodRemittance(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('orderId', new ParseUUIDPipe()) orderId: string,
        @Body() dto: ConfirmCodRemittanceDto,
    ): Promise<{ confirmed: true }> {
        const permissions = (permissionsHeader ?? '')
            .split(',')
            .map((item) => item.trim());
        if (!permissions.includes('admin.finance.reconcile'))
            throw new ForbiddenException(
                'Bạn không có quyền đối soát tài chính.',
            );
        await this.paymentService.confirmCodRemittance(
            orderId,
            adminId,
            dto.reference,
        );
        return { confirmed: true };
    }

    // Admin xác nhận giao dịch chuyển COD refund đã thành công, đính kèm bằng chứng do người xử lý cung cấp.
    @Post('cod-refunds/:returnId/confirmation')
    async confirmCodRefund(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('returnId', new ParseUUIDPipe()) returnId: string,
        @Body() dto: ConfirmCodRefundDto,
    ): Promise<{ confirmed: true }> {
        const permissions = (permissionsHeader ?? '')
            .split(',')
            .map((item) => item.trim());
        if (!permissions.includes('admin.finance.reconcile'))
            throw new ForbiddenException(
                'Bạn không có quyền đối soát tài chính.',
            );
        await this.paymentService.recordCodRefund({
            returnRequestId: returnId,
            adminId,
            reference: dto.reference,
            amount: dto.amount,
            proof: dto.proof,
        });
        return { confirmed: true };
    }

    // Kiểm tra permission server-side độc lập Gateway để không dựa riêng vào ẩn/hiện nút UI.
    private assertPermission(
        permissionsHeader: string,
        permission: string,
    ): void {
        if (
            !(permissionsHeader ?? '')
                .split(',')
                .map((item) => item.trim())
                .includes(permission)
        ) {
            throw new ForbiddenException(
                'Bạn không có quyền thực hiện thao tác tài chính này.',
            );
        }
    }

    // Chặn page và pageSize bất thường trước khi truy vấn sổ tiền có giới hạn.
    private toBoundedInteger(
        value: string | undefined,
        fallback: number,
        min: number,
        max: number,
    ): number {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(parsed)));
    }
}
