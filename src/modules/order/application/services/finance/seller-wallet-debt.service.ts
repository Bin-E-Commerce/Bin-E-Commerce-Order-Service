// Use case công nợ seller: trình bày snapshot, khóa ở ngưỡng/quá hạn và mở khi giảm dưới ngưỡng đúng hạn hoặc trả hết.
import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import {
    SELLER_WALLET_DEBT_DUE_DAYS,
    SELLER_WALLET_DEBT_LIMIT,
} from '@/modules/order/application/constants/seller-wallet-debt.constant';
import { SELLER_WALLET_DEBT_REPOSITORY } from '@/modules/order/application/contracts/finance/seller-wallet-debt.repository';
import type { SellerWalletDebtRepositoryPort } from '@/modules/order/application/contracts/finance/seller-wallet-debt.repository';
import { SellerFinanceLockClient } from '@/modules/order/application/clients/finance/seller-finance-lock.client';
import type {
    AdminSellerWalletDebtSummary,
    AdminSellerWalletDebtListQuery,
    AdminSellerWalletDebtPage,
    SellerWalletDebtLockCandidate,
    SellerWalletDebtSnapshot,
} from '@/modules/order/application/types/finance/seller-wallet-debt.type';
import { toCents } from '@/modules/order/application/utils/money/order-money.util';

const FINANCE_LOCK_SYNC_INTERVAL_MS = 60_000;
const FINANCE_LOCK_SYNC_BATCH_SIZE = 100;
const FINANCE_LOCK_SYNC_CONCURRENCY = 10;

@Injectable()
export class SellerWalletDebtService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SellerWalletDebtService.name);
    private syncTimer?: NodeJS.Timeout;
    private syncInProgress = false;

    constructor(
        @Inject(SELLER_WALLET_DEBT_REPOSITORY)
        private readonly repository: SellerWalletDebtRepositoryPort,
        private readonly sellerFinanceLockClient: SellerFinanceLockClient,
    ) {}

    // Bắt đầu đồng bộ khóa ngay khi service khởi động và lặp mỗi phút để hạn 3 ngày không phụ thuộc lần seller đăng nhập.
    onModuleInit(): void {
        this.syncTimer = setInterval(
            () => void this.syncFinanceLocksSafely(),
            FINANCE_LOCK_SYNC_INTERVAL_MS,
        );
        void this.syncFinanceLocksSafely();
    }

    // Dừng timer khi service thoát để worker không giữ process sống ngoài vòng đời ứng dụng.
    onModuleDestroy(): void {
        if (this.syncTimer) clearInterval(this.syncTimer);
    }

    // Trả số nợ dương cùng hạn/ngưỡng; ngày quá hạn được so theo đồng hồ máy chủ, không tin dữ liệu từ browser.
    async getShopSnapshot(shopId: string): Promise<SellerWalletDebtSnapshot> {
        const record = await this.repository.getForShop(shopId);
        const debtCents = toCents(record?.debtBalance ?? '0');
        const limitCents = toCents(SELLER_WALLET_DEBT_LIMIT);
        const dueAt = record?.dueAt ?? null;
        const hasDebt = debtCents > 0n;

        return {
            debtBalance: record?.debtBalance ?? '0.00',
            debtLimit: SELLER_WALLET_DEBT_LIMIT,
            debtDueDays: SELLER_WALLET_DEBT_DUE_DAYS,
            dueAt: dueAt?.toISOString() ?? null,
            isAtLimit: hasDebt && debtCents >= limitCents,
            isOverdue:
                hasDebt && dueAt !== null && dueAt.getTime() <= Date.now(),
            shopLocked: Boolean(record?.financeLockedAt),
        };
    }

    // Trả các chỉ số công nợ riêng để admin phân biệt khoản phải thu với tiền seller còn được nhận.
    async getAdminSummary(): Promise<AdminSellerWalletDebtSummary> {
        return this.repository.getAdminSummary();
    }

    // Trả danh sách nợ đã lọc/phân trang; giới hạn pageSize được xác thực ở DTO trước khi vào repository.
    async listAdminDebts(
        query: AdminSellerWalletDebtListQuery,
    ): Promise<AdminSellerWalletDebtPage> {
        return this.repository.listAdminDebts(query);
    }

    // Quét tối đa 100 shop/lượt và xử lý tối đa 10 HTTP calls song song để worker không dồn tải vào Seller Service.
    private async syncFinanceLocksSafely(): Promise<void> {
        // Ngăn hai lượt đồng bộ chồng nhau để lệnh khóa/mở shop không bị gửi lặp khi upstream phản hồi chậm.
        if (this.syncInProgress) return;
        this.syncInProgress = true;
        try {
            const candidates = await this.repository.findLockCandidates(
                SELLER_WALLET_DEBT_LIMIT,
                FINANCE_LOCK_SYNC_BATCH_SIZE,
            );
            for (
                let index = 0;
                index < candidates.length;
                index += FINANCE_LOCK_SYNC_CONCURRENCY
            ) {
                const batch = candidates.slice(
                    index,
                    index + FINANCE_LOCK_SYNC_CONCURRENCY,
                );
                const results = await Promise.allSettled(
                    batch.map((candidate) => this.syncFinanceLock(candidate)),
                );
                results.forEach((result, resultIndex) => {
                    // Giữ marker chưa đổi khi upstream lỗi để lượt quét tiếp theo retry đúng shop.
                    if (result.status === 'rejected') {
                        this.logger.error(
                            `Không đồng bộ được trạng thái khóa shop ${batch[resultIndex]?.shopId ?? 'không xác định'}.`,
                            result.reason instanceof Error
                                ? result.reason.stack
                                : undefined,
                        );
                    }
                });
            }
        } catch (error) {
            this.logger.error(
                'Không quét được công nợ cần đồng bộ trạng thái shop.',
                error instanceof Error ? error.stack : undefined,
            );
        } finally {
            this.syncInProgress = false;
        }
    }

    // Chỉ ghi marker sau khi Seller Service nhận lệnh; nếu DB trả nợ trong lúc gọi, lượt kế tiếp sẽ gửi lệnh mở khóa.
    private async syncFinanceLock(
        candidate: SellerWalletDebtLockCandidate,
    ): Promise<void> {
        await this.sellerFinanceLockClient.setShopFinanceLock(
            candidate.shopId,
            candidate.locked,
        );
        await this.repository.markFinanceLockSynced(
            candidate.shopId,
            candidate.locked,
        );
    }
}
