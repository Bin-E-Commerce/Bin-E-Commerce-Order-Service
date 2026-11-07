// Adapter SQL đọc khoản ví âm và trạng thái khóa; mọi câu truy vấn dùng dữ liệu số dư do wallet ledger sở hữu.
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SELLER_WALLET_DEBT_LIMIT } from '@/modules/order/application/constants/seller-wallet-debt.constant';
import type { SellerWalletDebtRepositoryPort } from '@/modules/order/application/contracts/finance/seller-wallet-debt.repository';
import type {
    AdminSellerWalletDebtSummary,
    SellerWalletDebtLockCandidate,
    SellerWalletDebtRecord,
} from '@/modules/order/application/types/finance/seller-wallet-debt.type';

@Injectable()
export class SellerWalletDebtRepository implements SellerWalletDebtRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Chuyển phần âm của available_balance thành khoản nợ dương để API không làm lộ quy ước dấu kế toán.
    async getForShop(shopId: string): Promise<SellerWalletDebtRecord | null> {
        const rows = (await this.dataSource.query(
            `
                SELECT
                    CASE WHEN available_balance < 0
                        THEN ABS(available_balance)::text
                        ELSE '0.00'
                    END AS "debtBalance",
                    debt_due_at AS "dueAt",
                    finance_locked_at AS "financeLockedAt"
                FROM seller_wallets
                WHERE shop_id = $1
            `,
            [shopId],
        )) as SellerWalletDebtRecord[];
        return rows[0] ?? null;
    }

    // Tổng hợp công nợ và số shop quá hạn trực tiếp trong DB, không cộng trùng công nợ vào số dư phải trả seller.
    async getAdminSummary(): Promise<AdminSellerWalletDebtSummary> {
        const [summary] = (await this.dataSource.query(
            `
                SELECT
                    COALESCE(SUM(GREATEST(-available_balance, 0)), 0)::text AS "sellerDebtBalance",
                    COUNT(*) FILTER (WHERE available_balance < 0)::int AS "sellerDebtShopCount",
                    COALESCE(SUM(GREATEST(-available_balance, 0)) FILTER (
                        WHERE available_balance < 0 AND debt_due_at <= NOW()
                    ), 0)::text AS "overdueSellerDebtBalance",
                    COUNT(*) FILTER (
                        WHERE available_balance < 0 AND debt_due_at <= NOW()
                    )::int AS "overdueSellerDebtShopCount",
                    COUNT(*) FILTER (WHERE finance_locked_at IS NOT NULL)::int AS "sellerDebtLockedShopCount"
                FROM seller_wallets
                WHERE available_balance < 0 OR finance_locked_at IS NOT NULL
            `,
        )) as AdminSellerWalletDebtSummary[];

        if (!summary) throw new Error('Không lấy được tổng công nợ seller.');
        return summary;
    }

    // Khóa ở ngưỡng 500.000 đồng/quá hạn; chỉ mở sớm nếu nợ xuống dưới ngưỡng và vẫn còn hạn thanh toán.
    async findLockCandidates(
        debtLimit: string,
        limit: number,
    ): Promise<SellerWalletDebtLockCandidate[]> {
        return (await this.dataSource.query(
            `
                SELECT shop_id AS "shopId", TRUE AS locked
                FROM seller_wallets
                WHERE available_balance < 0
                  AND finance_locked_at IS NULL
                  AND (
                    ABS(available_balance) >= $1::numeric
                    OR debt_due_at <= NOW()
                  )
                UNION ALL
                SELECT shop_id AS "shopId", FALSE AS locked
                FROM seller_wallets
                WHERE (
                    available_balance >= 0
                    OR (
                        available_balance < 0
                        AND ABS(available_balance) < $1::numeric
                        AND debt_due_at > NOW()
                    )
                )
                  AND finance_locked_at IS NOT NULL
                ORDER BY "shopId"
                LIMIT $2
            `,
            [debtLimit, limit],
        )) as SellerWalletDebtLockCandidate[];
    }

    // Đánh dấu đồng bộ chỉ sau khi Seller Service xác nhận HTTP thành công; retry an toàn nhờ cập nhật idempotent.
    async markFinanceLockSynced(
        shopId: string,
        locked: boolean,
    ): Promise<void> {
        if (locked) {
            // Ghi marker sau khi remote đã xác nhận; lượt sau sẽ xử lý nếu số dư đổi trong lúc gọi mạng.
            await this.dataSource.query(
                `UPDATE seller_wallets SET finance_locked_at = NOW() WHERE shop_id = $1 AND finance_locked_at IS NULL`,
                [shopId],
            );
            return;
        }

        // Chỉ xóa marker khi đã trả hết hoặc đã xuống dưới ngưỡng trước hạn; nợ quá hạn cần trả đủ mới mở.
        await this.dataSource.query(
            `UPDATE seller_wallets SET finance_locked_at = NULL WHERE shop_id = $1 AND finance_locked_at IS NOT NULL AND (available_balance >= 0 OR (available_balance < 0 AND ABS(available_balance) < $2::numeric AND debt_due_at > NOW()))`,
            [shopId, SELLER_WALLET_DEBT_LIMIT],
        );
    }
}
