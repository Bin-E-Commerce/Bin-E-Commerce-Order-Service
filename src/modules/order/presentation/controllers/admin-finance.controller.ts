// Controller admin ghi nhận các thao tác đối soát; quyền tài chính được kiểm tra lại từ header do Gateway xác thực.
import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
} from '@nestjs/common';
import { PaymentService } from '@/modules/order/application/services/payment/payment.service';
import { ConfirmCodRemittanceDto } from '@/modules/order/presentation/dto/confirm-cod-remittance.dto';
import { ConfirmCodRefundDto } from '@/modules/order/presentation/dto/confirm-cod-refund.dto';
import { Inject } from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import {
    AdminWalletWithdrawalActionDto,
    CreateFinanceSettlementBatchDto,
} from '@/modules/order/presentation/dto/wallet-finance.dto';

// Route quản lý đối soát và payout thủ công; không tự gọi ngân hàng hoặc chuyển tiền thật.
@Controller({ path: 'admin/finance', version: '1' })
export class AdminFinanceController {
    constructor(
        private readonly paymentService: PaymentService,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
    ) {}

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

    // Raw account number chỉ phục vụ nhân sự được cấp quyền payout để thực hiện chuyển khoản thủ công bên ngoài.
    @Get('withdrawals/:withdrawalId')
    async getWithdrawal(
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        return this.walletRepository.getAdminWithdrawal(withdrawalId);
    }

    // Admin đánh dấu đã nhận xử lý; thao tác không chạm số dư vì tiền vẫn đang giữ chỗ.
    @Post('withdrawals/:withdrawalId/processing')
    async markWithdrawalProcessing(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'PROCESSING',
            note: dto.note,
        });
        return { updated: true };
    }

    // Chỉ sau khi admin nhập mã tham chiếu chuyển ngoài hệ thống, số giữ chỗ mới bị trừ hẳn.
    @Post('withdrawals/:withdrawalId/paid')
    async confirmWithdrawalPaid(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'PAID',
            reference: dto.reference,
            note: dto.note,
        });
        return { updated: true };
    }

    // Từ chối hoàn phần giữ chỗ về số dư seller trong cùng transaction với audit status.
    @Post('withdrawals/:withdrawalId/reject')
    async rejectWithdrawal(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'REJECTED',
            note: dto.note,
        });
        return { updated: true };
    }

    // Ghi nhận lỗi chuyển khoản cũng giải phóng tiền đã giữ chỗ để seller có thể thử lại.
    @Post('withdrawals/:withdrawalId/fail')
    async failWithdrawal(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('withdrawalId', new ParseUUIDPipe()) withdrawalId: string,
        @Body() dto: AdminWalletWithdrawalActionDto,
    ) {
        this.assertPermission(permissionsHeader, 'admin.finance.payout');
        await this.walletRepository.transitionWithdrawal({
            withdrawalId,
            adminId,
            status: 'FAILED',
            note: dto.note,
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

    // Finance admin chỉ retry yêu cầu REFUND_FAILED; request mơ hồ giữ cùng requestId và không được tạo lệnh mới.
    @Post('vnpay-refunds/:returnId/retry')
    async retryVnpayRefund(
        @Headers('x-user-id') adminId: string,
        @Headers('x-user-permissions') permissionsHeader: string,
        @Param('returnId', new ParseUUIDPipe()) returnId: string,
    ): Promise<{ accepted: true }> {
        const permissions = (permissionsHeader ?? '')
            .split(',')
            .map((item) => item.trim());
        if (!permissions.includes('admin.finance.reconcile'))
            throw new ForbiddenException(
                'Bạn không có quyền đối soát tài chính.',
            );
        await this.paymentService.retryVnpayRefund(returnId, adminId);
        return { accepted: true };
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
