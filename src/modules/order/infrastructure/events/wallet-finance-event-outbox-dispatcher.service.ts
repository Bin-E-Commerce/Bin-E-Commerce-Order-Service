// Worker claim outbox ví seller và gửi Kafka theo at-least-once để có thể phục hồi sau gián đoạn broker.
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KafkaProducerService } from '@/kafka/kafka-producer.service';
import { WalletFinanceNotificationOutboxEntity } from '@/database/integration/entities/wallet-finance-notification-outbox.entity';

@Injectable()
export class WalletFinanceEventOutboxDispatcher
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(
        WalletFinanceEventOutboxDispatcher.name,
    );
    private dispatchTimer?: NodeJS.Timeout;
    private dispatching = false;

    constructor(
        @InjectRepository(WalletFinanceNotificationOutboxEntity)
        private readonly outbox: Repository<WalletFinanceNotificationOutboxEntity>,
        private readonly kafkaProducer: KafkaProducerService,
    ) {}

    // Quét event tồn ngay khi khởi động và định kỳ để Kafka phục hồi không cần thao tác thủ công.
    onModuleInit(): void {
        this.dispatchTimer = setInterval(
            () => void this.dispatchPendingSafe(),
            5000,
        );
        void this.dispatchPendingSafe();
    }

    // Dừng timer khi service shutdown để không giữ event loop mở.
    onModuleDestroy(): void {
        if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    }

    // Claim nhiều nhất 20 bản ghi; SKIP LOCKED cho phép nhiều instance chạy mà không gửi cùng row đồng thời.
    private async dispatchPending(): Promise<void> {
        await this.outbox.query(`
            UPDATE wallet_finance_notification_outbox
               SET status = 'PENDING', updated_at = now()
             WHERE status = 'PROCESSING'
               AND updated_at < now() - INTERVAL '1 minute'
        `);
        const claimResult: unknown = await this.outbox.query(`
            WITH claimed AS (
                SELECT event_id
                  FROM wallet_finance_notification_outbox
                 WHERE status = 'PENDING' AND available_at <= now()
                 ORDER BY created_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 20
            )
            UPDATE wallet_finance_notification_outbox AS outbox
               SET status = 'PROCESSING', updated_at = now()
              FROM claimed
             WHERE outbox.event_id = claimed.event_id
            RETURNING outbox.event_id AS event_id,
                      COALESCE(
                          NULLIF(BTRIM(outbox.topic), ''),
                          outbox.payload->>'eventName'
                      ) AS topic,
                      outbox.aggregate_id AS aggregate_id,
                      outbox.payload AS payload,
                      outbox.attempt_count AS attempt_count
        `);
        // Với UPDATE ... RETURNING, adapter TypeORM của PostgreSQL trả [rows, affectedCount]; chỉ duyệt phần rows.
        const rawRows =
            Array.isArray(claimResult) && Array.isArray(claimResult[0])
                ? claimResult[0]
                : claimResult;
        const rows = rawRows as Array<{
            event_id: string;
            topic: string | null;
            aggregate_id: string;
            payload: WalletFinanceNotificationOutboxEntity['payload'];
            attempt_count?: number | string | null;
        }>;

        if (rows.length === 0) return;

        // Publish tuần tự để giữ tải Kafka thấp; eventId cố định giúp consumer chống trùng nếu ACK bị mất.
        for (const row of rows) {
            // Dữ liệu outbox cũ có thể thiếu topic sau lần tạo lỗi; lấy tên event đã commit trong payload để cứu bản ghi.
            const storedTopic = row.topic?.trim();
            const topic =
                storedTopic && storedTopic !== 'undefined'
                    ? storedTopic
                    : row.payload?.eventName?.trim();
            // Query raw có thể trả attempt_count dưới dạng chuỗi hoặc thiếu ở dữ liệu cũ; chuẩn hóa để retry không sinh NaN.
            const parsedAttemptCount = Number(row.attempt_count ?? 0);
            const currentAttemptCount =
                Number.isSafeInteger(parsedAttemptCount) &&
                parsedAttemptCount >= 0
                    ? parsedAttemptCount
                    : 0;

            if (!topic) {
                this.logger.error(
                    `Wallet finance outbox event ${row.event_id} has no topic or eventName; retrying instead of blocking the batch`,
                );
                await this.scheduleRetry(row.event_id, currentAttemptCount);
                continue;
            }

            const published = await this.kafkaProducer.publish(
                topic,
                row.payload,
                row.aggregate_id,
            );
            if (published) {
                await this.outbox.update(
                    { eventId: row.event_id, status: 'PROCESSING' },
                    { status: 'PUBLISHED', publishedAt: new Date() },
                );
                continue;
            }

            // Backoff lũy thừa có trần một giờ để broker lỗi không tạo vòng gửi dồn dập.
            await this.scheduleRetry(row.event_id, currentAttemptCount);
        }
    }

    // Lên lịch retry tăng dần, có trần và jitter để event lỗi không chặn batch hoặc dồn tải lên Kafka.
    private async scheduleRetry(
        eventId: string,
        currentAttemptCount: number,
    ): Promise<void> {
        const attemptCount = currentAttemptCount + 1;
        const baseDelaySeconds = Math.min(
            3600,
            2 ** Math.min(attemptCount, 12),
        );
        // Jitter 20% tránh nhiều event tồn cùng lúc dồn retry vào Kafka khi broker vừa hồi phục.
        const delaySeconds = Math.round(
            baseDelaySeconds * (0.8 + Math.random() * 0.2),
        );
        await this.outbox.update(
            { eventId, status: 'PROCESSING' },
            {
                status: 'PENDING',
                attemptCount,
                availableAt: new Date(Date.now() + delaySeconds * 1000),
            },
        );
    }

    // Cô lập lỗi một vòng polling để broker hoặc database tạm lỗi không làm crash Order Service.
    private async dispatchPendingSafe(): Promise<void> {
        if (this.dispatching) return;
        this.dispatching = true;
        try {
            await this.dispatchPending();
        } catch (error) {
            this.logger.warn(
                `Wallet finance notification outbox deferred: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            this.dispatching = false;
        }
    }
}
