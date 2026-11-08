// Adapter SQL đọc khoản ví âm và trạng thái khóa; mọi câu truy vấn dùng dữ liệu số dư do wallet ledger sở hữu.
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SELLER_WALLET_DEBT_LIMIT } from '@/modules/order/application/constants/seller-wallet-debt.constant';
import type { SellerWalletDebtRepositoryPort } from '@/modules/order/application/contracts/finance/seller-wallet-debt.repository';
import type {
    AdminSellerWalletDebtSummary,
    AdminSellerWalletDebtListItem,
    AdminSellerWalletDebtListQuery,
    AdminSellerWalletDebtPage,
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

    // Phân trang shop đang nợ/đang khóa, áp dụng trạng thái và mã shop bằng tham số SQL để không nội suy input.
    async listAdminDebts(
        query: AdminSellerWalletDebtListQuery,
    ): Promise<AdminSellerWalletDebtPage> {
        const conditions = [
            '(available_balance < 0 OR finance_locked_at IS NOT NULL)',
        ];
        const filterParameters: unknown[] = [];

        // Các trạng thái là allow-list ở DTO; mỗi nhánh bổ sung điều kiện cố định để tránh lọc sai hoặc SQL injection.
        if (query.status === 'DEBT') {
            conditions.push('available_balance < 0');
        } else if (query.status === 'OVERDUE') {
            conditions.push(
                'available_balance < 0 AND debt_due_at IS NOT NULL AND debt_due_at <= NOW()',
            );
        } else if (query.status === 'LOCKED') {
            conditions.push('finance_locked_at IS NOT NULL');
        }

        const normalizedSearch = query.search
            ?.trim()
            .replace(/[%_\\]/g, '')
            .slice(0, 100);
        if (normalizedSearch) {
            filterParameters.push(`%${normalizedSearch}%`);
            conditions.push(`shop_id::text ILIKE $${filterParameters.length}`);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const limitParameterIndex = filterParameters.length + 1;
        const offsetParameterIndex = filterParameters.length + 2;
        const debtLimitParameterIndex = filterParameters.length + 3;
        const offset = (query.page - 1) * query.pageSize;

        // Count và page dùng cùng một where clause; thứ tự ưu tiên quá hạn/đang khóa giúp admin thấy khoản cần xử lý trước.
        const [countRows, items] = await Promise.all([
            this.dataSource.query(
                `SELECT COUNT(*)::int AS total FROM seller_wallets ${whereClause}`,
                filterParameters,
            ) as Promise<Array<{ total: number | string }>>,
            this.dataSource.query(
                `
                    SELECT
                        shop_id AS "shopId",
                        CASE WHEN available_balance < 0
                            THEN ABS(available_balance)::text
                            ELSE '0.00'
                        END AS "debtBalance",
                        debt_due_at AS "dueAt",
                        finance_locked_at AS "financeLockedAt",
                        (available_balance < 0 AND ABS(available_balance) >= $${debtLimitParameterIndex}::numeric) AS "isAtLimit",
                        (available_balance < 0 AND debt_due_at IS NOT NULL AND debt_due_at <= NOW()) AS "isOverdue",
                        updated_at AS "updatedAt"
                    FROM seller_wallets
                    ${whereClause}
                    ORDER BY
                        CASE
                            WHEN available_balance < 0 AND debt_due_at <= NOW() THEN 0
                            WHEN finance_locked_at IS NOT NULL THEN 1
                            ELSE 2
                        END,
                        debt_due_at ASC NULLS LAST,
                        ABS(available_balance) DESC,
                        updated_at DESC,
                        shop_id ASC
                    LIMIT $${limitParameterIndex}
                    OFFSET $${offsetParameterIndex}
                `,
                [
                    ...filterParameters,
                    query.pageSize,
                    offset,
                    SELLER_WALLET_DEBT_LIMIT,
                ],
            ) as Promise<AdminSellerWalletDebtListItem[]>,
        ]);

        return {
            items,
            total: Number(countRows[0]?.total ?? 0),
            page: query.page,
            pageSize: query.pageSize,
        };
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
