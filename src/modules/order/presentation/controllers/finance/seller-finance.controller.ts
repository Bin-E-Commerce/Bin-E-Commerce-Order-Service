// Controller expose ví seller theo shop đã resolve từ identity, không nhận shopId do browser truyền vào.
import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Post,
    Query,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { Inject } from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerOrderUserContext } from '@/modules/order/application/types/order/seller-order-user-context.type';
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import {
    CreateWalletDepositDto,
    CreateWalletWithdrawalDto,
} from '@/modules/order/presentation/dto/finance/wallet-finance.dto';

// Seller có thể nạp Sandbox và tạo yêu cầu payout; số dư chỉ đổi qua payment callback hoặc giao dịch backend.
@Controller({ path: 'seller/finance', version: '1' })
export class SellerFinanceController {
    constructor(
        private readonly sellerShopClient: SellerShopClient,
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly sellerWalletRepository: SellerWalletRepositoryPort,
        private readonly paymentService: PaymentService,
    ) {}

    // Kiểm tra danh tính/quyền trước khi gọi Seller Service resolve shop, rồi phân trang ledger ở Order Service.
    @Get('wallet')
    async getWallet(
        @Headers() headers: Record<string, unknown>,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
    ) {
        const user = this.buildUserContext(headers);
        if (!user.userId || !user.email)
            throw new UnauthorizedException(
                'Bạn cần đăng nhập để xem ví shop.',
            );
        if (!user.permissions.includes('seller.finance.read'))
            throw new ForbiddenException(
                'Bạn không có quyền xem tài chính của shop.',
            );
        const shopId = await this.sellerShopClient.getOwnedShopId(user);
        const page = this.toBoundedInteger(pageValue, 1, 1, 1_000_000);
        const pageSize = this.toBoundedInteger(pageSizeValue, 20, 1, 100);
        return this.sellerWalletRepository.getSnapshot(shopId, page, pageSize);
    }

    // Tạo URL nạp Pay2S Sandbox; callback IPN riêng mới ghi có nên response trình duyệt không thể tự cộng tiền.
    @Post('wallet/deposits')
    async createWalletDeposit(
        @Headers() headers: Record<string, unknown>,
        @Body() dto: CreateWalletDepositDto,
        @Req() request: Request,
    ) {
        const user = this.buildUserContext(headers);
        this.assertSellerFinanceAccess(user);
        const shopId = await this.sellerShopClient.getOwnedShopId(user);
        return this.paymentService.createWalletDeposit({
            shopId,
            sellerUserId: user.userId,
            amount: dto.amount,
            ipAddress: request.ip ?? '',
        });
    }

    // Giữ chỗ đúng số dư shop; ngân hàng và người nhận được snapshot server-side, không nhận từ browser.
    @Post('wallet/withdrawals')
    async createWithdrawal(
        @Headers() headers: Record<string, unknown>,
        @Body() dto: CreateWalletWithdrawalDto,
    ) {
        const user = this.buildUserContext(headers);
        this.assertSellerFinanceAccess(user);
        const account = await this.sellerShopClient.getPayoutAccount(user);
        return this.sellerWalletRepository.requestWithdrawal({
            shopId: account.shopId,
            sellerUserId: user.userId,
            amount: dto.amount,
            bankCode: account.bankCode ?? '',
            bankName: account.bankName ?? '',
            accountHolder: account.accountHolder ?? '',
            accountNumber: account.accountNumber ?? '',
        });
    }

    // Chỉ trả danh sách yêu cầu của shop hiện tại và số tài khoản đã che.
    @Get('wallet/withdrawals')
    async getWithdrawals(
        @Headers() headers: Record<string, unknown>,
        @Query('page') pageValue?: string,
        @Query('pageSize') pageSizeValue?: string,
    ) {
        const user = this.buildUserContext(headers);
        this.assertSellerFinanceAccess(user);
        const shopId = await this.sellerShopClient.getOwnedShopId(user);
        const page = this.toBoundedInteger(pageValue, 1, 1, 1_000_000);
        const pageSize = this.toBoundedInteger(pageSizeValue, 20, 1, 100);
        return this.sellerWalletRepository.listSellerWithdrawals(
            shopId,
            page,
            pageSize,
        );
    }

    // Một kiểm tra chung đảm bảo endpoint mutations cũng cần identity và permission đã được Gateway forward.
    private assertSellerFinanceAccess(user: SellerOrderUserContext): void {
        if (!user.userId || !user.email)
            throw new UnauthorizedException(
                'Bạn cần đăng nhập để quản lý ví shop.',
            );
        if (!user.permissions.includes('seller.finance.read'))
            throw new ForbiddenException(
                'Bạn không có quyền quản lý tài chính của shop.',
            );
    }

    // Chỉ chọn identity do Gateway xác thực và permission string; shop scope luôn được resolve phía server.
    private buildUserContext(
        headers: Record<string, unknown>,
    ): SellerOrderUserContext {
        return {
            userId: this.readHeader(headers, 'x-user-id'),
            email: this.readHeader(headers, 'x-user-email'),
            permissions: this.readHeader(headers, 'x-user-permissions')
                .split(',')
                .map((permission) => permission.trim())
                .filter(Boolean),
        };
    }

    // Đọc header do Gateway forward kể cả khi HTTP adapter chuẩn hóa thành danh sách giá trị.
    private readHeader(headers: Record<string, unknown>, name: string): string {
        const value = headers[name];
        return Array.isArray(value)
            ? String(value[0] ?? '')
            : typeof value === 'string'
              ? value
              : '';
    }

    // Chặn NaN, số âm và pageSize quá lớn để query ledger luôn có giới hạn tài nguyên.
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
