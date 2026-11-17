// Dispatcher gửi cleanup selection đã commit trong Order DB sang Cart Service và retry khi dependency lỗi.
// Order vẫn là nguồn sự thật của giao dịch; Cart thực thi thay đổi idempotent theo orderId.

import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CartClient } from '@/modules/order/application/clients/cart.client';
import { OrderCartCleanupOutboxEntity } from '@/database/integration/entities/order-cart-cleanup-outbox.entity';

type ClaimedCartCleanup = Pick<
    OrderCartCleanupOutboxEntity,
    'orderId' | 'ownerId' | 'items' | 'attemptCount' | 'cleanupMode'
> & { cleanupBefore: string | null };

const MAX_CONCURRENT_CART_CLEANUPS = 5;

// Polling durable outbox để Cart Service hồi phục thì cleanup được tiếp tục dù pod Order đã restart.
@Injectable()
export class OrderCartCleanupOutboxDispatcher
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(OrderCartCleanupOutboxDispatcher.name);
    private dispatchTimer?: NodeJS.Timeout;
    private dispatching = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly cartClient: CartClient,
    ) {}

    // Khởi động retry nền ngay khi module sẵn sàng; claim bằng SKIP LOCKED cho phép nhiều pod cùng chạy.
    onModuleInit(): void {
        this.dispatchTimer = setInterval(
            () => void this.dispatchPendingSafe(),
            5_000,
        );
        void this.dispatchPendingSafe();
    }

    // Dừng poller khi shutdown để không giữ process mở.
    onModuleDestroy(): void {
        if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    }

    // Claim các job đến hạn, chỉ dọn COD chưa hủy hoặc Pay2S đã thu tiền.
    // Lease PROCESSING được thu hồi sau một phút nếu pod chết giữa lúc gọi Cart.
    // Cart giữ marker theo orderId nên response timeout hoặc worker trùng không áp dụng quantity lần hai.
    private async dispatchPendingSafe(): Promise<void> {
        if (this.dispatching) return;
        this.dispatching = true;
        try {
            const jobs = await this.claimPendingJobs(25);
            // Chạy theo nhóm 5 vì Cart request timeout sau 5 giây; nhóm cuối cùng vẫn bắt đầu trước lease 1 phút.
            // allSettled để một lỗi cập nhật trạng thái không làm các job còn lại mắc ở PROCESSING đến lúc lease hết hạn.
            for (
                let offset = 0;
                offset < jobs.length;
                offset += MAX_CONCURRENT_CART_CLEANUPS
            ) {
                const batch = jobs.slice(
                    offset,
                    offset + MAX_CONCURRENT_CART_CLEANUPS,
                );
                const results = await Promise.allSettled(
                    batch.map((job) => this.dispatchJob(job)),
                );
                for (const result of results) {
                    if (result.status === 'rejected') {
                        this.logger.error(
                            'Không cập nhật được trạng thái cart cleanup; lease sẽ cho phép retry.',
                            result.reason instanceof Error
                                ? result.reason.stack
                                : undefined,
                        );
                    }
                }
            }
            await this.abandonCancelledJobs();
        } catch (error) {
            this.logger.error(
                'Không quét được cart cleanup outbox.',
                error instanceof Error ? error.stack : undefined,
            );
        } finally {
            this.dispatching = false;
        }
    }

    // Dành job đến hạn cho đúng một worker và thu hồi lease bị bỏ dở sau khi process dừng đột ngột.
    private async claimPendingJobs(
        limit: number,
    ): Promise<ClaimedCartCleanup[]> {
        return this.dataSource.transaction(async (manager) => {
            const rows = (await manager.query(
                `WITH claimable AS (
                    SELECT cleanup.order_id
                    FROM order_cart_cleanup_outbox cleanup
                    INNER JOIN orders payment_order
                        ON payment_order.id = cleanup.order_id
                    WHERE (
                        (cleanup.status = 'PENDING' AND cleanup.available_at <= now())
                        OR (
                            cleanup.status = 'PROCESSING'
                            AND cleanup.updated_at <= now() - INTERVAL '1 minute'
                        )
                    )
                    AND (
                        (
                            payment_order.payment_method = 'COD'
                            AND payment_order.status = 'CONFIRMED'
                        )
                        OR (
                            payment_order.payment_method = 'PAY2S'
                            AND payment_order.payment_status IN (
                                'PAID', 'REFUND_PENDING', 'REFUNDED'
                            )
                        )
                    )
                    ORDER BY cleanup.available_at, cleanup.created_at
                    LIMIT $1
                    FOR UPDATE OF cleanup SKIP LOCKED
                )
                UPDATE order_cart_cleanup_outbox cleanup
                SET status = 'PROCESSING',
                    attempt_count = cleanup.attempt_count + 1,
                    updated_at = now()
                FROM claimable
                WHERE cleanup.order_id = claimable.order_id
                RETURNING cleanup.order_id, cleanup.owner_id, cleanup.items,
                          cleanup.attempt_count, cleanup.cleanup_mode,
                          to_char(
                              cleanup.cleanup_before AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                          ) AS cleanup_before`,
                [limit],
            )) as Array<{
                order_id: string;
                owner_id: string;
                items: ClaimedCartCleanup['items'];
                attempt_count: number;
                cleanup_mode: ClaimedCartCleanup['cleanupMode'];
                cleanup_before: string | null;
            }>;
            return rows.map((row) => ({
                orderId: row.order_id,
                ownerId: row.owner_id,
                items: row.items,
                attemptCount: Number(row.attempt_count),
                cleanupMode: row.cleanup_mode,
                cleanupBefore: row.cleanup_before,
            }));
        });
    }

    // Chuyển trạng thái chỉ sau khi Cart commit marker và quantity changes; mọi lỗi sẽ được hẹn retry tăng dần.
    private async dispatchJob(job: ClaimedCartCleanup): Promise<void> {
        try {
            if (job.cleanupMode === 'LEGACY_FULL_CART') {
                if (!job.cleanupBefore)
                    throw new Error('Legacy cart cleanup thiếu mốc tạo order.');
                await this.cartClient.checkoutLegacyCartBefore(
                    job.ownerId,
                    job.orderId,
                    job.cleanupBefore,
                );
            } else if (job.cleanupMode === 'LEGACY_ITEM_IDS') {
                if (!job.cleanupBefore)
                    throw new Error('Legacy item cleanup thiếu mốc tạo order.');
                await this.cartClient.checkoutCartItemIds(
                    job.ownerId,
                    job.orderId,
                    job.items.map((item) => item.itemId),
                    job.cleanupBefore,
                );
            } else {
                await this.cartClient.checkoutCartItems(
                    job.ownerId,
                    job.orderId,
                    job.items,
                );
            }
            await this.dataSource
                .getRepository(OrderCartCleanupOutboxEntity)
                .update(
                    { orderId: job.orderId, status: 'PROCESSING' },
                    { status: 'COMPLETED', lastError: null },
                );
        } catch (error) {
            const retryDelayMs = Math.min(
                300_000,
                5_000 * 2 ** Math.min(job.attemptCount - 1, 6),
            );
            const errorMessage =
                error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : 'Cart Service cleanup failed.';
            await this.dataSource
                .getRepository(OrderCartCleanupOutboxEntity)
                .update(
                    { orderId: job.orderId, status: 'PROCESSING' },
                    {
                        status: 'PENDING',
                        availableAt: new Date(Date.now() + retryDelayMs),
                        lastError: errorMessage,
                    },
                );
            this.logger.warn(
                `Cart cleanup order ${job.orderId} sẽ thử lại sau ${retryDelayMs}ms: ${errorMessage}`,
            );
        }
    }

    // Bỏ qua cleanup Pay2S chưa thanh toán hoặc COD đã hủy để không xóa cart của lần mua tiếp theo.
    // PROCESSING chỉ được bỏ khi lease hết hạn, tránh đánh dấu job đang được worker khác gửi là đã bỏ.
    private async abandonCancelledJobs(): Promise<void> {
        await this.dataSource.query(`
            UPDATE order_cart_cleanup_outbox cleanup
            SET status = 'ABANDONED', updated_at = now()
            FROM orders payment_order
            WHERE payment_order.id = cleanup.order_id
              AND (
                  cleanup.status = 'PENDING'
                  OR (
                      cleanup.status = 'PROCESSING'
                      AND cleanup.updated_at <= now() - INTERVAL '1 minute'
                  )
              )
              AND payment_order.status = 'CANCELLED'
              AND (
                  payment_order.payment_method = 'COD'
                  OR payment_order.payment_status NOT IN (
                      'PAID', 'REFUND_PENDING', 'REFUNDED'
                  )
              )
        `);
    }
}
