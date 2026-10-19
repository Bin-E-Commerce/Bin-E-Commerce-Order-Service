// Adapter persistence ví seller; số dư và ledger thay đổi cùng transaction để giữ sổ kép nhất quán.
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { SellerWallet } from '@/database/payment/entities/seller-wallet.entity';
import { SellerWalletLedger } from '@/database/payment/entities/seller-wallet-ledger.entity';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { WalletDeposit } from '@/database/payment/entities/wallet-deposit.entity';
import { WalletWithdrawalRequest } from '@/database/payment/entities/wallet-withdrawal-request.entity';
import { PlatformFinanceLedger } from '@/database/payment/entities/platform-finance-ledger.entity';
import { FinanceSettlementBatch } from '@/database/payment/entities/finance-settlement-batch.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/order-money.util';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletSnapshot } from '@/modules/order/application/types/seller-wallet.type';
import type {
    AdminFinanceSnapshot,
    AdminWalletWithdrawalRecord,
    PlatformFinanceLedgerRecord,
    WalletDepositRecord,
    WalletWithdrawalRecord,
} from '@/modules/order/application/types/wallet-finance.type';

// Chống ghi trùng theo nguồn order/shop; ví chỉ nhận tiền hàng, không nhận phí giao hoặc phí gateway.
@Injectable()
export class SellerWalletRepository
    implements SellerWalletRepositoryPort, OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(SellerWalletRepository.name);
    private releaseTimer?: NodeJS.Timeout;
    private releasing = false;

    constructor(private readonly dataSource: DataSource) {}

    // Định kỳ giải phóng ledger đủ điều kiện; DB lock/unique source key bảo vệ khi chạy nhiều replica.
    onModuleInit(): void {
        this.releaseTimer = setInterval(
            () => void this.runReleaseSafely(),
            60_000,
        );
        void this.runReleaseSafely();
    }

    // Dọn timer khi service dừng để không giữ worker/process sống ngoài vòng đời ứng dụng.
    onModuleDestroy(): void {
        if (this.releaseTimer) clearInterval(this.releaseTimer);
    }

    // Bắt lỗi worker nền để không tạo unhandled rejection; ledger chưa đổi sẽ được thử lại ở lượt kế tiếp.
    private async runReleaseSafely(): Promise<void> {
        try {
            await this.releaseEligibleBalances();
        } catch (error) {
            this.logger.error(
                'Không giải phóng được số dư ví seller.',
                error instanceof Error ? error.stack : undefined,
            );
        }
    }

    // Ghi tiền hàng đầy đủ vào pending cho từng shop sau khi payment LIVE hoặc Sandbox đã được xác nhận.
    async creditOrderPending(orderId: string): Promise<void> {
        await this.dataSource.transaction(async (manager) =>
            this.creditOrderPendingInTransaction(manager, orderId),
        );
    }

    // Hoàn tất order là mốc mở khóa tiền ngay; worker nền vẫn chạy để bù nếu lần release trực tiếp lỗi.
    async releaseCompletedOrder(orderId: string): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const order = await manager
                .getRepository(Order)
                .findOne({ where: { id: orderId } });
            if (
                !order ||
                order.fulfillmentStatus !== OrderFulfillmentStatus.COMPLETED ||
                order.paymentStatus !== PaymentStatus.PAID
            )
                return;
            if (
                order.paymentMethod === PaymentMethod.COD &&
                !order.codRemittedAt
            )
                return;
            await this.releaseEligibleBalances(manager, orderId);
        });
    }

    // Ghi chi phí GHN một lần; shop chịu phí sẽ có thể âm ví, còn khách chịu phí được khấu trừ từ refund riêng.
    async recordReturnShippingFee(
        returnRequestId: string,
        amountValue: string,
    ): Promise<void> {
        const amount = toCents(amountValue);
        if (amount <= 0n) return;
        await this.dataSource.transaction(async (manager) => {
            const request = await manager
                .getRepository(OrderReturnRequest)
                .findOne({
                    where: { id: returnRequestId },
                    lock: { mode: 'pessimistic_write' },
                });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            const sourceKey = `return-shipping:${request.id}`;
            const platformLedger = manager.getRepository(PlatformFinanceLedger);
            const existingEntry = await platformLedger.findOne({
                where: { sourceKey },
                lock: { mode: 'pessimistic_write' },
            });
            if (existingEntry) {
                // Retry chỉ ACK cùng số tiền; nếu carrier đổi amount sau lần ghi đầu, giữ sai lệch rõ để admin điều tra.
                // Ledger expense là số âm còn parser tiền chỉ nhận số không âm, nên so snapshot decimal đã chuẩn hóa.
                if (String(existingEntry.amount) !== fromCents(-amount)) {
                    throw new ConflictException(
                        'Phí vận chuyển hoàn đã được ghi với số tiền khác.',
                    );
                }
                return;
            }
            if (request.returnShippingPayer === 'SELLER') {
                await manager.query(
                    `INSERT INTO "seller_wallets" ("shop_id") VALUES ($1) ON CONFLICT ("shop_id") DO NOTHING`,
                    [request.shopId],
                );
                const wallet = await manager
                    .getRepository(SellerWallet)
                    .findOne({
                        where: { shopId: request.shopId },
                        lock: { mode: 'pessimistic_write' },
                    });
                if (!wallet)
                    throw new Error(
                        'Không tạo được ví shop để ghi nhận phí hoàn.',
                    );
                wallet.availableBalance = fromCents(
                    toCents(wallet.availableBalance) - amount,
                );
                await manager.getRepository(SellerWallet).save(wallet);
                await manager.getRepository(SellerWalletLedger).save({
                    shopId: request.shopId,
                    orderId: request.orderId,
                    returnRequestId: request.id,
                    kind: 'RETURN_SHIPPING_DEBIT',
                    amount: fromCents(-amount),
                    sourceKey,
                    availableAt: null,
                });
            } else if (request.returnShippingPayer !== 'CUSTOMER') {
                throw new ConflictException(
                    'Chưa xác định bên chịu phí vận chuyển hoàn hàng.',
                );
            }
            await platformLedger.save({
                kind: 'RETURN_SHIPPING_FEE',
                amount: fromCents(-amount),
                sourceKey,
                shopId: request.shopId,
                orderId: request.orderId,
                returnRequestId: request.id,
                reference: null,
                settlementBatchId: null,
                createdBy: null,
            });
        });
    }

    // Ghi khoản phải thu khi khách chịu phí nhưng yêu cầu không được hoàn; khoản này không làm tăng số dư tiền mặt mô phỏng.
    async recordCustomerReturnShippingReceivable(
        returnRequestId: string,
        amountValue: string,
    ): Promise<void> {
        const amount = toCents(amountValue);
        if (amount <= 0n) return;
        await this.dataSource.transaction(async (manager) => {
            const request = await manager
                .getRepository(OrderReturnRequest)
                .findOne({
                    where: { id: returnRequestId },
                    lock: { mode: 'pessimistic_write' },
                });
            if (
                !request ||
                request.status !== OrderReturnStatus.INSPECTION_FAILED ||
                request.returnShippingPayer !== 'CUSTOMER' ||
                !request.returnShippingFinalizedAt ||
                toCents(request.returnShippingCost) !== amount
            ) {
                throw new ConflictException(
                    'Chỉ ghi nhận phí phải thu sau khi GHN đã chốt phí và shop từ chối hoàn tiền.',
                );
            }

            const sourceKey = `return-shipping-receivable:${request.id}`;
            const ledgerRepository = manager.getRepository(
                PlatformFinanceLedger,
            );
            const existingEntry = await ledgerRepository.findOne({
                where: { sourceKey },
                lock: { mode: 'pessimistic_write' },
            });
            if (existingEntry) {
                if (toCents(existingEntry.amount) !== amount) {
                    throw new ConflictException(
                        'Khoản phải thu phí hoàn đã được ghi với số tiền khác.',
                    );
                }
                return;
            }

            await ledgerRepository.save({
                kind: 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE',
                amount: fromCents(amount),
                sourceKey,
                shopId: request.shopId,
                orderId: request.orderId,
                returnRequestId: request.id,
                reference: null,
                settlementBatchId: null,
                createdBy: null,
            });
        });
    }

    // Tạo top-up Sandbox riêng với đơn hàng để mã tham chiếu và idempotency không dùng chung PaymentAttempt.
    async createWalletDeposit(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        merchantReference: string;
        expiresAt: Date;
    }): Promise<WalletDepositRecord> {
        const amount = toCents(input.amount);
        // `toCents` lưu đơn vị 1/100 đồng, nên ngưỡng VND phải đổi sang cents trước khi so sánh.
        if (amount < 1_000_000n || amount > 100_000_000_000n)
            throw new BadRequestException(
                'Số tiền nạp phải từ 10.000 đến 1.000.000.000 đồng.',
            );
        const deposit = await this.dataSource
            .getRepository(WalletDeposit)
            .save({
                shopId: input.shopId,
                sellerUserId: input.sellerUserId,
                merchantReference: input.merchantReference,
                providerTransactionId: null,
                status: 'PENDING',
                environment: 'SANDBOX',
                amount: fromCents(amount),
                expiresAt: input.expiresAt,
                providerResponse: null,
                confirmedAt: null,
            });
        return this.toDepositRecord(deposit);
    }

    // Tra cứu theo mã merchant đã ký trong IPN; callback không thể chọn shop hoặc số tiền.
    async getWalletDepositByReference(merchantReference: string) {
        const deposit = await this.dataSource
            .getRepository(WalletDeposit)
            .findOne({ where: { merchantReference } });
        if (!deposit) return null;
        return {
            id: deposit.id,
            shopId: deposit.shopId,
            sellerUserId: deposit.sellerUserId,
            amount: deposit.amount,
            status: deposit.status,
            expiresAt: deposit.expiresAt,
            providerTransactionId: deposit.providerTransactionId,
        };
    }

    // IPN hợp lệ ghi top-up, ví khả dụng và sổ nền tảng cùng transaction; trạng thái đã PAID chỉ ACK giao dịch trùng.
    async confirmWalletDeposit(input: {
        depositId: string;
        transactionId: string;
        providerResponse: Record<string, unknown>;
    }): Promise<'PAID' | 'DUPLICATE' | 'NOT_PENDING'> {
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(WalletDeposit);
            const deposit = await repository.findOne({
                where: { id: input.depositId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!deposit) return 'NOT_PENDING';
            if (deposit.status === 'PAID')
                return deposit.providerTransactionId === input.transactionId
                    ? 'DUPLICATE'
                    : 'NOT_PENDING';
            if (deposit.status !== 'PENDING') return 'NOT_PENDING';
            const walletRepository = manager.getRepository(SellerWallet);
            await manager.query(
                `INSERT INTO "seller_wallets" ("shop_id") VALUES ($1) ON CONFLICT ("shop_id") DO NOTHING`,
                [deposit.shopId],
            );
            const wallet = await walletRepository.findOne({
                where: { shopId: deposit.shopId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!wallet)
                throw new Error('Không tạo được ví seller cho giao dịch nạp.');
            wallet.availableBalance = fromCents(
                toCents(wallet.availableBalance) + toCents(deposit.amount),
            );
            await walletRepository.save(wallet);
            deposit.status = 'PAID';
            deposit.providerTransactionId = input.transactionId;
            deposit.confirmedAt = new Date();
            deposit.providerResponse = input.providerResponse;
            await repository.save(deposit);
            await manager.getRepository(SellerWalletLedger).save({
                shopId: deposit.shopId,
                orderId: null,
                returnRequestId: null,
                kind: 'WALLET_DEPOSIT',
                amount: deposit.amount,
                sourceKey: `wallet-deposit:${deposit.id}`,
                availableAt: deposit.confirmedAt,
            });
            await manager.getRepository(PlatformFinanceLedger).save({
                kind: 'WALLET_DEPOSIT',
                amount: deposit.amount,
                sourceKey: `wallet-deposit:${deposit.id}`,
                shopId: deposit.shopId,
                orderId: null,
                returnRequestId: null,
                reference: input.transactionId,
                settlementBatchId: null,
                createdBy: null,
            });
            return 'PAID';
        });
    }

    // Lưu callback thất bại nhưng không cho callback cũ ghi đè giao dịch đã được xác nhận thành công.
    async failWalletDeposit(
        depositId: string,
        providerResponse: Record<string, unknown>,
    ): Promise<void> {
        await this.dataSource
            .getRepository(WalletDeposit)
            .createQueryBuilder()
            .update(WalletDeposit)
            .set({
                status: 'FAILED',
                providerResponse: () => 'CAST(:providerResponse AS jsonb)',
            })
            .setParameter('providerResponse', JSON.stringify(providerResponse))
            .where('id = :depositId AND status = :pending', {
                depositId,
                pending: 'PENDING',
            })
            .execute();
    }

    // Khóa số dư seller trước khi giữ chỗ, nên hai request đồng thời không thể dành vượt phần còn rút được.
    async requestWithdrawal(input: {
        shopId: string;
        sellerUserId: string;
        amount: string;
        bankCode: string;
        bankName: string;
        accountHolder: string;
        accountNumber: string;
    }): Promise<WalletWithdrawalRecord> {
        const amount = toCents(input.amount);
        // Giữ cùng ngưỡng tối thiểu với form nạp: 10.000 VND tương ứng 1.000.000 cents.
        if (amount < 1_000_000n)
            throw new BadRequestException(
                'Số tiền rút tối thiểu là 10.000 đồng.',
            );
        if (
            !input.bankCode.trim() ||
            !input.bankName.trim() ||
            !input.accountHolder.trim() ||
            !/^\d{6,30}$/.test(input.accountNumber)
        ) {
            throw new BadRequestException(
                'Hồ sơ shop chưa có tài khoản ngân hàng nhận tiền hợp lệ.',
            );
        }
        return this.dataSource.transaction(async (manager) => {
            const wallet = await manager.getRepository(SellerWallet).findOne({
                where: { shopId: input.shopId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!wallet)
                throw new BadRequestException(
                    'Ví shop chưa có số dư khả dụng.',
                );
            if (toCents(wallet.availableBalance) < amount)
                throw new ConflictException(
                    'Số dư khả dụng không đủ cho yêu cầu rút tiền.',
                );
            wallet.availableBalance = fromCents(
                toCents(wallet.availableBalance) - amount,
            );
            wallet.reservedBalance = fromCents(
                toCents(wallet.reservedBalance) + amount,
            );
            await manager.getRepository(SellerWallet).save(wallet);
            const withdrawal = await manager
                .getRepository(WalletWithdrawalRequest)
                .save({
                    shopId: input.shopId,
                    sellerUserId: input.sellerUserId,
                    amount: fromCents(amount),
                    bankCode: input.bankCode.trim(),
                    bankName: input.bankName.trim(),
                    accountHolder: input.accountHolder.trim(),
                    accountNumber: input.accountNumber,
                    accountNumberMasked: this.maskAccountNumber(
                        input.accountNumber,
                    ),
                    status: 'REQUESTED',
                    transferReference: null,
                    adminNote: null,
                    processedBy: null,
                    processedAt: null,
                });
            await manager.getRepository(SellerWalletLedger).save({
                shopId: input.shopId,
                orderId: null,
                returnRequestId: null,
                kind: 'WITHDRAWAL_RESERVED',
                amount: fromCents(-amount),
                sourceKey: `withdrawal:${withdrawal.id}:reserve`,
                availableAt: null,
            });
            return this.toWithdrawalRecord(withdrawal);
        });
    }

    // Seller chỉ xem yêu cầu thuộc shop đã được resolve phía server; tài khoản luôn được mask trước khi trả về.
    async listSellerWithdrawals(
        shopId: string,
        page: number,
        pageSize: number,
    ): Promise<{ items: WalletWithdrawalRecord[]; total: number }> {
        const [rows, total] = await this.dataSource
            .getRepository(WalletWithdrawalRequest)
            .findAndCount({
                where: { shopId },
                order: { createdAt: 'DESC' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            });
        return {
            items: rows.map((row) => this.toWithdrawalRecord(row)),
            total,
        };
    }

    // Tạo màn admin bằng dữ liệu tổng hợp và trang ledger; chi tiết số tài khoản chỉ trả qua endpoint quyền payout.
    async getAdminFinance(
        page: number,
        pageSize: number,
    ): Promise<AdminFinanceSnapshot> {
        const manager = this.dataSource.manager;
        const [totals] = (await manager.query(`
            SELECT
                COALESCE((SELECT SUM(amount) FROM platform_finance_ledger WHERE kind <> 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE'), 0)::text AS platform_balance,
                COALESCE((SELECT SUM(pending_balance + available_balance) FROM seller_wallets), 0)::text AS seller_payable,
                COALESCE((SELECT SUM(reserved_balance) FROM seller_wallets), 0)::text AS reserved_withdrawals,
                COALESCE((SELECT SUM(amount) FROM platform_finance_ledger WHERE kind = 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE'), 0)::text AS customer_return_shipping_receivable,
                (SELECT COUNT(*)::int FROM wallet_withdrawal_requests WHERE status IN ('REQUESTED','PROCESSING')) AS pending_withdrawals,
                COALESCE((SELECT SUM(amount) FROM wallet_deposits WHERE status = 'PAID'), 0)::text AS deposits
        `)) as Array<{
            platform_balance: string;
            seller_payable: string;
            reserved_withdrawals: string;
            customer_return_shipping_receivable: string;
            pending_withdrawals: number;
            deposits: string;
        }>;
        if (!totals)
            throw new Error(
                'Không lấy được số liệu tổng quan tài chính nền tảng.',
            );
        const [ledgerRows, totalLedger] = await manager
            .getRepository(PlatformFinanceLedger)
            .findAndCount({
                order: { createdAt: 'DESC' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            });
        const withdrawals = await manager
            .getRepository(WalletWithdrawalRequest)
            .find({ order: { createdAt: 'DESC' }, take: 10 });
        const deposits = await manager
            .getRepository(WalletDeposit)
            .find({ order: { createdAt: 'DESC' }, take: 10 });
        return {
            platformBalance: totals.platform_balance,
            sellerPayableBalance: totals.seller_payable,
            reservedWithdrawalBalance: totals.reserved_withdrawals,
            customerReturnShippingReceivable:
                totals.customer_return_shipping_receivable,
            pendingWithdrawals: Number(totals.pending_withdrawals),
            sandboxDepositTotal: totals.deposits,
            ledger: ledgerRows.map((row) => this.toPlatformLedgerRecord(row)),
            withdrawals: withdrawals.map((row) => this.toWithdrawalRecord(row)),
            deposits: deposits.map((row) => this.toDepositRecord(row)),
            totalLedger,
            page,
            pageSize,
        };
    }

    // Lọc trạng thái bằng danh sách cho phép để query không nhận biểu thức tự do từ admin UI.
    async listAdminWithdrawals(
        page: number,
        pageSize: number,
        status?: string,
    ): Promise<{ items: WalletWithdrawalRecord[]; total: number }> {
        const allowed = [
            'REQUESTED',
            'PROCESSING',
            'PAID',
            'REJECTED',
            'FAILED',
        ];
        const where =
            status && allowed.includes(status)
                ? { status: status as WalletWithdrawalRequest['status'] }
                : {};
        const [rows, total] = await this.dataSource
            .getRepository(WalletWithdrawalRequest)
            .findAndCount({
                where,
                order: { createdAt: 'ASC' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            });
        return {
            items: rows.map((row) => this.toWithdrawalRecord(row)),
            total,
        };
    }

    // Đọc tài khoản đầy đủ chỉ tại route admin tài chính; mọi danh sách thông thường dùng số đã che.
    async getAdminWithdrawal(
        withdrawalId: string,
    ): Promise<AdminWalletWithdrawalRecord> {
        const row = await this.dataSource
            .getRepository(WalletWithdrawalRequest)
            .createQueryBuilder('withdrawal')
            .addSelect('withdrawal.accountNumber')
            .where('withdrawal.id = :withdrawalId', { withdrawalId })
            .getOne();
        if (!row)
            throw new BadRequestException('Không tìm thấy yêu cầu rút tiền.');
        return {
            ...this.toWithdrawalRecord(row),
            accountNumber: row.accountNumber,
            sellerUserId: row.sellerUserId,
        };
    }

    // Admin chỉ xác nhận kết quả chuyển khoản ngoài hệ thống; transition khóa request và ví để chốt tiền đúng một lần.
    async transitionWithdrawal(input: {
        withdrawalId: string;
        adminId: string;
        status: 'PROCESSING' | 'PAID' | 'REJECTED' | 'FAILED';
        reference?: string;
        note?: string;
    }): Promise<void> {
        if (!input.adminId.trim())
            throw new BadRequestException('Thiếu danh tính admin.');
        if (input.status === 'PAID' && !input.reference?.trim())
            throw new BadRequestException(
                'Cần mã tham chiếu chuyển khoản để xác nhận đã chi.',
            );
        await this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(WalletWithdrawalRequest);
            const request = await repository.findOne({
                where: { id: input.withdrawalId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu rút tiền.',
                );
            if (input.status === 'PROCESSING') {
                if (request.status === 'PROCESSING') return;
                if (request.status !== 'REQUESTED')
                    throw new ConflictException(
                        'Yêu cầu không còn ở trạng thái chờ xử lý.',
                    );
                request.status = 'PROCESSING';
            } else {
                if (request.status === input.status) {
                    if (
                        input.status !== 'PAID' ||
                        request.transferReference === input.reference?.trim()
                    )
                        return;
                    throw new ConflictException(
                        'Yêu cầu đã được xác nhận với mã tham chiếu khác.',
                    );
                }
                if (!['REQUESTED', 'PROCESSING'].includes(request.status))
                    throw new ConflictException(
                        'Yêu cầu đã được xử lý trước đó.',
                    );
                const wallet = await manager
                    .getRepository(SellerWallet)
                    .findOne({
                        where: { shopId: request.shopId },
                        lock: { mode: 'pessimistic_write' },
                    });
                if (
                    !wallet ||
                    toCents(wallet.reservedBalance) < toCents(request.amount)
                )
                    throw new ConflictException(
                        'Số tiền giữ chỗ không khớp yêu cầu rút.',
                    );
                wallet.reservedBalance = fromCents(
                    toCents(wallet.reservedBalance) - toCents(request.amount),
                );
                const ledgerRepository =
                    manager.getRepository(SellerWalletLedger);
                if (input.status === 'PAID') {
                    // Khoản reserve đã trừ available khi tạo request; PAID chỉ giải phóng reserved và ghi dòng chi thật ở platform ledger.
                    await ledgerRepository.save({
                        shopId: request.shopId,
                        orderId: null,
                        returnRequestId: null,
                        kind: 'WITHDRAWAL_PAID',
                        amount: '0.00',
                        sourceKey: `withdrawal:${request.id}:paid`,
                        availableAt: null,
                    });
                    await manager.getRepository(PlatformFinanceLedger).save({
                        kind: 'SELLER_PAYOUT',
                        amount: fromCents(-toCents(request.amount)),
                        sourceKey: `withdrawal:${request.id}:paid`,
                        shopId: request.shopId,
                        orderId: null,
                        returnRequestId: null,
                        reference: input.reference!.trim(),
                        settlementBatchId: null,
                        createdBy: input.adminId,
                    });
                    request.transferReference = input.reference!.trim();
                } else {
                    wallet.availableBalance = fromCents(
                        toCents(wallet.availableBalance) +
                            toCents(request.amount),
                    );
                    await ledgerRepository.save({
                        shopId: request.shopId,
                        orderId: null,
                        returnRequestId: null,
                        kind: 'WITHDRAWAL_RELEASED',
                        amount: request.amount,
                        sourceKey: `withdrawal:${request.id}:release`,
                        availableAt: null,
                    });
                }
                await manager.getRepository(SellerWallet).save(wallet);
                request.status = input.status;
                request.processedBy = input.adminId;
                request.processedAt = new Date();
            }
            request.adminNote = input.note?.trim() || request.adminNote;
            await repository.save(request);
        });
    }

    // Trả ledger nền tảng đã mask mọi dữ liệu tài khoản; page size được chặn tại controller.
    async getPlatformLedger(
        page: number,
        pageSize: number,
    ): Promise<{ items: PlatformFinanceLedgerRecord[]; total: number }> {
        const [rows, total] = await this.dataSource
            .getRepository(PlatformFinanceLedger)
            .findAndCount({
                order: { createdAt: 'DESC' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            });
        return {
            items: rows.map((row) => this.toPlatformLedgerRecord(row)),
            total,
        };
    }

    // Chỉ ghép dòng tiền thực đã thu/chi; receivable chưa thu đứng ngoài đối soát cash và việc nhóm không đổi số dư ví.
    async createSettlementBatch(input: {
        adminId: string;
        note?: string;
        ledgerIds: string[];
    }): Promise<{ id: string; ledgerCount: number }> {
        if (
            !input.adminId.trim() ||
            input.ledgerIds.length === 0 ||
            input.ledgerIds.length > 500
        )
            throw new BadRequestException(
                'Đợt đối soát cần có từ 1 đến 500 giao dịch.',
            );
        return this.dataSource.transaction(async (manager) => {
            const ledgerRepository = manager.getRepository(
                PlatformFinanceLedger,
            );
            const rows = await ledgerRepository
                .createQueryBuilder('ledger')
                .setLock('pessimistic_write')
                .where('ledger.id IN (:...ids)', { ids: input.ledgerIds })
                .getMany();
            if (
                rows.length !== new Set(input.ledgerIds).size ||
                rows.some((row) => row.settlementBatchId)
            )
                throw new ConflictException(
                    'Có giao dịch không tồn tại hoặc đã thuộc đợt đối soát khác.',
                );
            // Khoản phải thu chưa được thu tiền nên không thể ghép vào đợt đối soát tiền mặt với VNPay/ngân hàng.
            if (
                rows.some(
                    (row) => row.kind === 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE',
                )
            )
                throw new ConflictException(
                    'Khoản phí hoàn khách chưa trả không thể ghép vào đợt đối soát tiền mặt.',
                );
            const batch = await manager
                .getRepository(FinanceSettlementBatch)
                .save({
                    status: 'OPEN',
                    note: input.note?.trim() || null,
                    createdBy: input.adminId,
                    reconciledBy: null,
                    reconciledAt: null,
                });
            await ledgerRepository.update(input.ledgerIds, {
                settlementBatchId: batch.id,
            });
            return { id: batch.id, ledgerCount: rows.length };
        });
    }

    // Chốt audit đợt đối soát một lần, không dùng trạng thái này làm điều kiện giải phóng ví seller.
    async reconcileSettlementBatch(input: {
        batchId: string;
        adminId: string;
    }): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(FinanceSettlementBatch);
            const batch = await repository.findOne({
                where: { id: input.batchId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!batch)
                throw new BadRequestException('Không tìm thấy đợt đối soát.');
            if (batch.status === 'RECONCILED') return;
            batch.status = 'RECONCILED';
            batch.reconciledBy = input.adminId;
            batch.reconciledAt = new Date();
            await repository.save(batch);
        });
    }

    // Chỉ xác nhận COD sau khi order hoàn tất và khoản thu đã được ghi rõ bằng chứng từ admin.
    async confirmCodRemittance(
        orderId: string,
        adminId: string,
        reference: string,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const order = await manager.getRepository(Order).findOne({
                where: { id: orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!order)
                throw new BadRequestException('Không tìm thấy đơn hàng.');
            if (
                order.paymentMethod !== PaymentMethod.COD ||
                order.paymentStatus !== PaymentStatus.PAID ||
                order.fulfillmentStatus !== OrderFulfillmentStatus.COMPLETED
            ) {
                throw new ConflictException(
                    'Chỉ xác nhận COD đã thu và đơn đã hoàn tất.',
                );
            }
            const normalizedReference = reference.trim();
            if (!normalizedReference)
                throw new BadRequestException('Cần mã giao dịch đối soát COD.');
            if (order.codRemittedAt) {
                if (order.codRemittanceReference !== normalizedReference)
                    throw new ConflictException(
                        'Đơn này đã được đối soát với mã giao dịch khác.',
                    );
                return;
            }
            order.codRemittedAt = new Date();
            order.codRemittanceReference = normalizedReference;
            order.codRemittanceConfirmedBy = adminId;
            await manager.getRepository(Order).save(order);
            await this.creditOrderPendingInTransaction(manager, orderId);
        });
        await this.releaseCompletedOrder(orderId);
    }

    // Đảo đúng phần tiền hàng đã ghi cho shop; khoản nợ phát sinh được giữ âm thay vì làm mất dấu hoàn tiền đã trả khách.
    // Nếu chưa có bút toán sale (ví dụ COD được hoàn trước remittance), seller chưa từng nhận khoản đó nên không ghi nợ.
    // Hai khóa nguồn riêng cho pending/available khiến retry an toàn; transaction bảo vệ số dư và ledger cùng nhau.
    async reverseRefund(returnRequestId: string): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const request = await manager
                .getRepository(OrderReturnRequest)
                .findOne({
                    where: { id: returnRequestId },
                    lock: { mode: 'pessimistic_write' },
                });
            if (!request || request.status !== 'REFUNDED') return;
            if (request.refundMethod === 'VNPAY') {
                const platformLedger = manager.getRepository(
                    PlatformFinanceLedger,
                );
                const sourceKey = `refund:${request.id}:platform`;
                if (!(await platformLedger.exist({ where: { sourceKey } }))) {
                    await platformLedger.save({
                        kind: 'VNPAY_REFUND',
                        amount: fromCents(-toCents(request.refundAmount)),
                        sourceKey,
                        shopId: request.shopId,
                        orderId: request.orderId,
                        returnRequestId: request.id,
                        reference: request.refundTransactionReference,
                        settlementBatchId: null,
                        createdBy: request.refundProcessedBy,
                    });
                }
            }
            const amount = toCents(request.refundItemAmount);
            if (amount <= 0n) return;
            const ledgerRepository = manager.getRepository(SellerWalletLedger);
            const saleLedger = await ledgerRepository.findOne({
                where: {
                    sourceKey: `sale:${request.orderId}:${request.shopId}`,
                },
            });
            if (!saleLedger) return;
            // Sale ledger đầu tiên đã trừ return hoàn trước thời điểm ghi; không đảo lần hai nếu remittance race.
            if (
                request.refundProcessedAt &&
                request.refundProcessedAt <= saleLedger.createdAt
            )
                return;

            const wallet = await manager.getRepository(SellerWallet).findOne({
                where: { shopId: request.shopId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!wallet)
                throw new Error(
                    'Không tìm thấy ví shop để điều chỉnh hoàn tiền.',
                );

            // Phân bổ khoản đảo theo đúng order/shop; pending tổng của shop có thể thuộc các order khác.
            const allocation = (await manager.query(
                `SELECT
                    COALESCE(SUM(amount) FILTER (WHERE kind = 'SALE_PENDING'), 0)::text AS sale_amount,
                    COALESCE(SUM(amount) FILTER (WHERE kind = 'RELEASE_AVAILABLE'), 0)::text AS released_amount,
                    COALESCE(SUM(amount) FILTER (WHERE kind = 'REFUND_PENDING_REVERSAL'), 0)::text AS pending_reversed,
                    COALESCE(SUM(amount) FILTER (WHERE kind = 'REFUND_AVAILABLE_REVERSAL'), 0)::text AS available_reversed
                 FROM seller_wallet_ledger
                 WHERE order_id = $1 AND shop_id = $2`,
                [request.orderId, request.shopId],
            )) as Array<{
                sale_amount: string;
                released_amount: string;
                pending_reversed: string;
                available_reversed: string;
            }>;
            const orderLedger = allocation[0];
            const refundablePending =
                toCents(orderLedger?.sale_amount ?? '0') -
                toCents(orderLedger?.released_amount ?? '0') +
                toCents(orderLedger?.pending_reversed ?? '0');
            const refundableAvailable =
                toCents(orderLedger?.released_amount ?? '0') +
                toCents(orderLedger?.available_reversed ?? '0');
            const pendingKey = `refund:${request.id}:pending`;
            const availableKey = `refund:${request.id}:available`;
            const alreadyApplied = await ledgerRepository.exist({
                where: [{ sourceKey: pendingKey }, { sourceKey: availableKey }],
            });
            if (alreadyApplied) return;
            if (amount > refundablePending + refundableAvailable) {
                throw new ConflictException(
                    'Khoản hoàn vượt phần tiền hàng shop còn được ghi nhận.',
                );
            }
            const pendingBalance = toCents(wallet.pendingBalance);
            const pendingDebit =
                refundablePending > 0n
                    ? refundablePending < amount
                        ? refundablePending
                        : amount
                    : 0n;
            const availableDebit = amount - pendingDebit;

            // Không bù sai lệch ledger bằng tiền của order khác; transaction rollback để có thể điều tra.
            if (pendingBalance < pendingDebit) {
                throw new ConflictException(
                    'Số dư chờ không khớp ledger của khoản cần hoàn.',
                );
            }

            wallet.pendingBalance = fromCents(pendingBalance - pendingDebit);
            // Cho phép available âm: hoàn khách là nghĩa vụ đã phát sinh, còn thiếu hụt seller được bù bằng doanh thu sau này.
            wallet.availableBalance = fromCents(
                toCents(wallet.availableBalance) - availableDebit,
            );
            await manager.getRepository(SellerWallet).save(wallet);
            if (pendingDebit > 0n) {
                await ledgerRepository.save(
                    ledgerRepository.create({
                        shopId: request.shopId,
                        orderId: request.orderId,
                        returnRequestId: request.id,
                        kind: 'REFUND_PENDING_REVERSAL',
                        amount: fromCents(-pendingDebit),
                        sourceKey: pendingKey,
                        availableAt: null,
                    }),
                );
            }
            if (availableDebit > 0n) {
                await ledgerRepository.save(
                    ledgerRepository.create({
                        shopId: request.shopId,
                        orderId: request.orderId,
                        returnRequestId: request.id,
                        kind: 'REFUND_AVAILABLE_REVERSAL',
                        amount: fromCents(-availableDebit),
                        sourceKey: availableKey,
                        availableAt: null,
                    }),
                );
            }
        });
    }

    // Ghi nhận COD hoàn thủ công theo số tiền backend đã tính và giữ proof/reference để admin kiểm toán.
    async recordCodRefund(input: {
        returnRequestId: string;
        adminId: string;
        reference: string;
        amount: string;
        proof: Record<string, unknown>;
    }): Promise<void> {
        const reference = input.reference.trim();
        if (!reference)
            throw new BadRequestException('Cần mã giao dịch hoàn tiền COD.');
        await this.dataSource.transaction(async (manager) => {
            const requestRepository = manager.getRepository(OrderReturnRequest);
            const request = await requestRepository.findOne({
                where: { id: input.returnRequestId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            const order = await manager.getRepository(Order).findOne({
                where: { id: request.orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (
                !order ||
                order.paymentMethod !== PaymentMethod.COD ||
                order.paymentStatus !== PaymentStatus.PAID
            ) {
                throw new ConflictException(
                    'Chỉ ghi nhận hoàn thủ công cho đơn COD đã thu tiền.',
                );
            }
            if (request.status === 'REFUNDED') {
                if (request.refundTransactionReference !== reference)
                    throw new ConflictException(
                        'Yêu cầu này đã được hoàn bằng mã giao dịch khác.',
                    );
                return;
            }
            if (
                request.status !== 'REFUND_PENDING' &&
                request.status !== 'REFUND_FAILED'
            ) {
                throw new ConflictException(
                    'Yêu cầu hoàn chưa được seller kiểm tra đạt.',
                );
            }
            if (toCents(input.amount) !== toCents(request.refundAmount)) {
                throw new ConflictException(
                    'Số tiền phải khớp số hoàn do Order Service tính.',
                );
            }
            const previousRefunds = await requestRepository
                .createQueryBuilder('return_request')
                .select(
                    'COALESCE(SUM(return_request.refund_amount), 0)',
                    'amount',
                )
                .where('return_request.order_id = :orderId', {
                    orderId: order.id,
                })
                .andWhere('return_request.status = :status', {
                    status: 'REFUNDED',
                })
                .andWhere('return_request.id <> :returnId', {
                    returnId: request.id,
                })
                .getRawOne<{ amount: string }>();
            if (
                toCents(previousRefunds?.amount ?? '0') +
                    toCents(request.refundAmount) >
                toCents(order.totalAmount)
            ) {
                throw new ConflictException(
                    'Tổng các khoản hoàn vượt số tiền đã thanh toán.',
                );
            }
            request.status = OrderReturnStatus.REFUNDED;
            request.refundMethod = 'COD_MANUAL';
            request.refundTransactionReference = reference;
            request.refundProof = input.proof;
            request.refundProcessedBy = input.adminId;
            request.refundProcessedAt = new Date();
            await requestRepository.save(request);
            await manager.getRepository(PlatformFinanceLedger).save({
                kind: 'COD_REFUND',
                amount: fromCents(-toCents(input.amount)),
                sourceKey: `cod-refund:${request.id}:platform`,
                shopId: request.shopId,
                orderId: request.orderId,
                returnRequestId: request.id,
                reference,
                settlementBatchId: null,
                createdBy: input.adminId,
            });
            if (
                toCents(previousRefunds?.amount ?? '0') +
                    toCents(request.refundAmount) >=
                toCents(order.totalAmount)
            ) {
                order.paymentStatus = PaymentStatus.REFUNDED;
                await manager.getRepository(Order).save(order);
            }
        });
        await this.reverseRefund(input.returnRequestId);
    }

    // Tính phần hàng theo snapshot/shop, trừ các return đã hoàn trước khi COD
    // remittance tạo sale ledger lần đầu.
    // Khi sale ledger đã tồn tại, mọi lần lặp đều dừng tại source key nên refund sau đó chỉ đi qua reverseRefund.
    // Sandbox được hạch toán như giao dịch thành công trong ví nội bộ; shipping fee và phí gateway vẫn không thuộc tiền seller.
    private async creditOrderPendingInTransaction(
        manager: EntityManager,
        orderId: string,
    ): Promise<void> {
        // Khóa riêng aggregate Order; khóa cùng relation items khiến TypeORM sinh
        // LEFT JOIN ... FOR UPDATE, cú pháp PostgreSQL từ chối ở phía nullable.
        const order = await manager.getRepository(Order).findOne({
            where: { id: orderId },
            lock: { mode: 'pessimistic_write' },
        });
        // Chỉ callback payment đã xác nhận mới được ghi sổ; cờ Sandbox chỉ lưu nguồn thanh toán, không làm mất doanh thu seller.
        if (!order || order.paymentStatus !== PaymentStatus.PAID) return;
        // COD chưa remittance chưa tạo quyền nhận tiền; admin sẽ gọi lại sau khi xác nhận khoản thu.
        if (order.paymentMethod === PaymentMethod.COD && !order.codRemittedAt)
            return;

        const platformLedger = manager.getRepository(PlatformFinanceLedger);
        const platformSourceKey =
            order.paymentMethod === PaymentMethod.COD
                ? `cod-remittance:${order.id}`
                : `order-payment:${order.id}`;
        if (
            !(await platformLedger.exist({
                where: { sourceKey: platformSourceKey },
            }))
        ) {
            const paymentAttempt =
                order.paymentMethod === PaymentMethod.VNPAY
                    ? await manager.getRepository(PaymentAttempt).findOne({
                          where: { orderId: order.id, status: 'PAID' },
                          order: { createdAt: 'DESC' },
                      })
                    : null;
            await platformLedger.save({
                kind:
                    order.paymentMethod === PaymentMethod.COD
                        ? 'COD_REMITTANCE'
                        : 'ORDER_PAYMENT',
                amount: order.totalAmount,
                sourceKey: platformSourceKey,
                shopId: null,
                orderId: order.id,
                returnRequestId: null,
                reference:
                    paymentAttempt?.providerTransactionId ??
                    order.codRemittanceReference ??
                    order.orderNumber,
                settlementBatchId: null,
                createdBy:
                    order.paymentMethod === PaymentMethod.COD
                        ? order.codRemittanceConfirmedBy
                        : null,
            });
        }

        // Item là snapshot bất biến sau checkout nên đọc riêng trong cùng
        // transaction vẫn nhất quán, đồng thời tránh JOIN trong câu lệnh khóa.
        // Chỉ đọc items sau điều kiện thanh toán để giảm I/O cho các order khác.
        const orderItems = await manager.getRepository(OrderItem).find({
            where: { orderId: order.id },
        });
        const grossByShop = new Map<string, bigint>();
        for (const item of orderItems) {
            if (!item.sellerShopId) continue;
            grossByShop.set(
                item.sellerShopId,
                (grossByShop.get(item.sellerShopId) ?? 0n) +
                    toCents(item.lineTotal),
            );
        }

        for (const [shopId, grossAmount] of grossByShop) {
            const sourceKey = `sale:${order.id}:${shopId}`;
            const ledgerRepository = manager.getRepository(SellerWalletLedger);
            // Dùng idempotency key trước khi chạm balance để retry callback không cộng lại khoản sale.
            if (await ledgerRepository.exist({ where: { sourceKey } }))
                continue;

            const refundedBeforeCredit = await manager
                .getRepository(OrderReturnRequest)
                .createQueryBuilder('return_request')
                .select(
                    'COALESCE(SUM(return_request.refund_item_amount), 0)',
                    'amount',
                )
                .where('return_request.order_id = :orderId', {
                    orderId: order.id,
                })
                .andWhere('return_request.shop_id = :shopId', { shopId })
                .andWhere('return_request.status = :status', {
                    status: OrderReturnStatus.REFUNDED,
                })
                .getRawOne<{ amount: string }>();
            const netAmount =
                grossAmount - toCents(refundedBeforeCredit?.amount ?? '0');
            // Return COD có thể được admin hoàn trước remittance; không cấp cho shop phần đã trả lại khách.
            if (netAmount <= 0n) {
                // Marker 0 giữ idempotency để reconciliation không quét lại mãi order đã hoàn đủ trước khi ghi sale.
                await manager.getRepository(SellerWalletLedger).save({
                    shopId,
                    orderId: order.id,
                    returnRequestId: null,
                    kind: 'SALE_PENDING',
                    amount: '0.00',
                    sourceKey,
                    availableAt: null,
                });
                continue;
            }

            await manager.query(
                `INSERT INTO "seller_wallets" ("shop_id") VALUES ($1) ON CONFLICT ("shop_id") DO NOTHING`,
                [shopId],
            );
            const wallet = await manager.getRepository(SellerWallet).findOne({
                where: { shopId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!wallet)
                throw new Error(`Không tạo được ví cho shop ${shopId}.`);
            wallet.pendingBalance = fromCents(
                toCents(wallet.pendingBalance) + netAmount,
            );
            await manager.getRepository(SellerWallet).save(wallet);
            await ledgerRepository.save(
                ledgerRepository.create({
                    shopId,
                    orderId: order.id,
                    returnRequestId: null,
                    kind: 'SALE_PENDING',
                    amount: fromCents(netAmount),
                    sourceKey,
                    availableAt: null,
                }),
            );
        }
    }

    // Chuyển pending sang available ngay khi hoàn tất; job và thao tác trực tiếp dùng chung khóa ledger idempotent.
    private async releaseEligibleBalances(
        transactionManager?: EntityManager,
        onlyOrderId?: string,
    ): Promise<void> {
        const release = async (manager: EntityManager) => {
            // Reconcile trước release để đơn đã thanh toán nhưng callback lỗi vẫn được tạo SALE_PENDING trong cùng transaction.
            await this.reconcileMissingPaidOrderCredits(
                undefined,
                manager,
                onlyOrderId,
            );
            const dueLedger = (await manager.query(
                `
                    SELECT ledger.id, ledger.shop_id, ledger.order_id,
                           ledger.amount + COALESCE((
                               SELECT SUM(reversal.amount)
                               FROM seller_wallet_ledger reversal
                               WHERE reversal.order_id = ledger.order_id
                                 AND reversal.shop_id = ledger.shop_id
                                 AND reversal.kind = 'REFUND_PENDING_REVERSAL'
                           ), 0) AS amount,
                           ledger.source_key
                    FROM seller_wallet_ledger ledger
                    INNER JOIN orders order_row ON order_row.id = ledger.order_id
                    WHERE ledger.kind = 'SALE_PENDING'
                      AND order_row.fulfillment_status = 'COMPLETED'
                      AND order_row.payment_status = 'PAID'
                      AND (order_row.payment_method <> 'COD' OR order_row.cod_remitted_at IS NOT NULL)
                      AND ledger.amount + COALESCE((
                          SELECT SUM(reversal.amount)
                          FROM seller_wallet_ledger reversal
                          WHERE reversal.order_id = ledger.order_id
                            AND reversal.shop_id = ledger.shop_id
                            AND reversal.kind = 'REFUND_PENDING_REVERSAL'
                      ), 0) > 0
                      AND NOT EXISTS (
                          SELECT 1
                          FROM seller_wallet_ledger released
                          WHERE released.source_key = 'release:' || ledger.source_key
                      )
                      AND ($1::uuid IS NULL OR order_row.id = $1)
                    ORDER BY order_row.return_window_until ASC
                    LIMIT 50
                    FOR UPDATE OF ledger SKIP LOCKED
                `,
                [onlyOrderId ?? null],
            )) as Array<{
                id: string;
                shop_id: string;
                order_id: string;
                amount: string;
                source_key: string;
            }>;
            for (const entry of dueLedger) {
                const sourceKey = `release:${entry.source_key}`;
                const ledgerRepository =
                    manager.getRepository(SellerWalletLedger);
                if (await ledgerRepository.exist({ where: { sourceKey } }))
                    continue;
                const amount = toCents(entry.amount);
                // Marker 0 giữ idempotency cho order đã hoàn đủ; không phát sinh biến động balance.
                if (amount <= 0n) continue;
                const wallet = await manager
                    .getRepository(SellerWallet)
                    .findOne({
                        where: { shopId: entry.shop_id },
                        lock: { mode: 'pessimistic_write' },
                    });
                if (!wallet) continue;
                const pendingBalance = toCents(wallet.pendingBalance);
                // Guard này biến sai lệch sổ cái thành lỗi transaction có thể điều tra, thay vì để pending âm.
                if (pendingBalance < amount) {
                    throw new ConflictException(
                        'Số dư chờ seller thấp hơn ledger đủ điều kiện giải phóng.',
                    );
                }
                wallet.pendingBalance = fromCents(pendingBalance - amount);
                wallet.availableBalance = fromCents(
                    toCents(wallet.availableBalance) + amount,
                );
                await manager.getRepository(SellerWallet).save(wallet);
                await ledgerRepository.save(
                    ledgerRepository.create({
                        shopId: entry.shop_id,
                        orderId: entry.order_id,
                        returnRequestId: null,
                        kind: 'RELEASE_AVAILABLE',
                        amount: entry.amount,
                        sourceKey,
                        availableAt: new Date(),
                    }),
                );
            }
        };
        if (transactionManager) {
            await release(transactionManager);
            return;
        }
        if (this.releasing) return;
        this.releasing = true;
        try {
            await this.dataSource.transaction(release);
        } finally {
            this.releasing = false;
        }
    }

    // Bù ledger bị lỡ trước để snapshot không bỏ sót tiền hàng đã thanh toán.
    // Mỗi trang tra mã đơn của orderId đang hiển thị theo lô, tránh truy vấn N+1.
    // orderNumber là mã công khai; orderId vẫn giữ liên kết nội bộ và fallback nếu đơn đã bị xóa.
    async getSnapshot(
        shopId: string,
        page: number,
        pageSize: number,
    ): Promise<SellerWalletSnapshot> {
        await this.reconcileMissingPaidOrderCredits(shopId);
        const wallet = await this.dataSource
            .getRepository(SellerWallet)
            .findOne({ where: { shopId } });
        const [transactions, total] = await this.dataSource
            .getRepository(SellerWalletLedger)
            .findAndCount({
                where: { shopId },
                order: { createdAt: 'DESC', id: 'DESC' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            });
        const orderIds = [
            ...new Set(
                transactions
                    .map((transaction) => transaction.orderId)
                    .filter((id): id is string => Boolean(id)),
            ),
        ];
        const orders =
            orderIds.length > 0
                ? await this.dataSource.getRepository(Order).find({
                      where: { id: In(orderIds) },
                      select: { id: true, orderNumber: true },
                  })
                : [];
        const orderNumberById = new Map(
            orders.map((order) => [order.id, order.orderNumber] as const),
        );
        return {
            shopId,
            pendingBalance: wallet?.pendingBalance ?? '0.00',
            availableBalance: wallet?.availableBalance ?? '0.00',
            reservedBalance: wallet?.reservedBalance ?? '0.00',
            transactions: transactions.map((transaction) => ({
                id: transaction.id,
                orderId: transaction.orderId,
                orderNumber: transaction.orderId
                    ? (orderNumberById.get(transaction.orderId) ?? null)
                    : null,
                returnRequestId: transaction.returnRequestId,
                kind: transaction.kind,
                amount: transaction.amount,
                createdAt: transaction.createdAt.toISOString(),
                availableAt: transaction.availableAt?.toISOString() ?? null,
            })),
            total,
            page,
            pageSize,
        };
    }

    // Bù các đơn đã thanh toán nhưng chưa có bút toán, để callback cũ bị lỗi không làm mất doanh thu trong ví.
    // Khóa nguồn sale khiến việc mở ví lặp lại an toàn; COD chỉ được bù sau khi đã xác nhận đối soát.
    private async reconcileMissingPaidOrderCredits(
        shopId?: string,
        transactionManager?: EntityManager,
        onlyOrderId?: string,
    ): Promise<void> {
        const reconcile = async (manager: EntityManager) => {
            const missingOrders = (await manager.query(
                `SELECT DISTINCT order_row.id
                 FROM orders order_row
                 WHERE order_row.payment_status = $3
                   AND (order_row.payment_method <> $4 OR order_row.cod_remitted_at IS NOT NULL)
                   AND EXISTS (
                       SELECT 1
                       FROM order_items missing_item
                       WHERE missing_item.order_id = order_row.id
                         AND missing_item.seller_shop_id IS NOT NULL
                         AND ($1::uuid IS NULL OR missing_item.seller_shop_id = $1)
                         AND NOT EXISTS (
                             SELECT 1
                             FROM seller_wallet_ledger ledger
                             WHERE ledger.source_key = 'sale:' || order_row.id || ':' || missing_item.seller_shop_id
                         )
                   )
                   AND ($2::uuid IS NULL OR order_row.id = $2)
                 ORDER BY order_row.id
                 LIMIT 100`,
                [
                    shopId ?? null,
                    onlyOrderId ?? null,
                    PaymentStatus.PAID,
                    PaymentMethod.COD,
                ],
            )) as Array<{ id: string }>;

            // Dùng cùng hàm ghi ledger của callback để giữ nguyên phép tính theo shop, hoàn tiền và idempotency.
            for (const order of missingOrders) {
                await this.creditOrderPendingInTransaction(manager, order.id);
            }
        };
        if (transactionManager) {
            await reconcile(transactionManager);
            return;
        }
        await this.dataSource.transaction(reconcile);
    }

    // Chỉ trả bản ghi top-up cần thiết cho UI; provider response và merchant reference không bị lộ.
    private toDepositRecord(row: WalletDeposit): WalletDepositRecord {
        return {
            id: row.id,
            amount: row.amount,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            confirmedAt: row.confirmedAt?.toISOString() ?? null,
        };
    }

    // Che phần lớn số tài khoản trên danh sách seller/admin; chỉ endpoint admin payout được phép đọc bản đầy đủ.
    private maskAccountNumber(value: string): string {
        return value.length <= 4
            ? '*'.repeat(value.length)
            : `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
    }

    // Chuyển entity payout thành response an toàn, không serialize raw accountNumber.
    private toWithdrawalRecord(
        row: WalletWithdrawalRequest,
    ): WalletWithdrawalRecord {
        return {
            id: row.id,
            shopId: row.shopId,
            amount: row.amount,
            bankName: row.bankName,
            accountHolder: row.accountHolder,
            accountNumberMasked: row.accountNumberMasked,
            status: row.status,
            transferReference: row.transferReference,
            adminNote: row.adminNote,
            createdAt: row.createdAt.toISOString(),
            processedAt: row.processedAt?.toISOString() ?? null,
        };
    }

    // Biến timestamp/entity về hợp đồng trung lập để trang admin không phụ thuộc TypeORM.
    private toPlatformLedgerRecord(
        row: PlatformFinanceLedger,
    ): PlatformFinanceLedgerRecord {
        return {
            id: row.id,
            kind: row.kind,
            amount: row.amount,
            shopId: row.shopId,
            orderId: row.orderId,
            returnRequestId: row.returnRequestId,
            reference: row.reference,
            settlementBatchId: row.settlementBatchId,
            createdBy: row.createdBy,
            createdAt: row.createdAt.toISOString(),
        };
    }
}
