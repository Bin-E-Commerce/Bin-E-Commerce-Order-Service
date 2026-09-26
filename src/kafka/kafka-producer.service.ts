// File này quản lý một Kafka producer cho các integration event của Order Service.
// Producer không làm rollback order khi broker tạm thời lỗi; lỗi được log để nghiệp vụ checkout không bị gián đoạn.

import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(KafkaProducerService.name);
    private readonly producer: Producer;
    private connected = false;
    private connecting?: Promise<void>;

    // Khởi tạo producer theo brokers từ environment để local và production dùng chung một adapter.
    constructor(private readonly config: ConfigService) {
        const brokers = this.config
            .get<string>('KAFKA_BROKERS', 'localhost:29092')
            .split(',')
            .map((broker) => broker.trim())
            .filter(Boolean);

        const kafka = new Kafka({
            clientId: this.config.get<string>(
                'KAFKA_CLIENT_ID',
                'order-service',
            ),
            brokers,
            retry: { retries: 3 },
        });

        this.producer = kafka.producer();
    }

    // Kết nối Kafka khi service khởi động nhưng không chặn HTTP server nếu broker local chưa chạy.
    async onModuleInit(): Promise<void> {
        try {
            await this.ensureConnected();
            this.logger.log('Kafka producer connected');
        } catch (error) {
            this.logger.warn(
                `Kafka producer connect failed (non-fatal): ${String(error)}`,
            );
        }
    }

    // Đóng producer khi Nest shutdown để dev watch không giữ connection cũ.
    async onModuleDestroy(): Promise<void> {
        this.connected = false;
        await this.producer.disconnect().catch(() => void 0);
    }

    // Trả kết quả publish để outbox chỉ chuyển PUBLISHED sau khi Kafka xác nhận thành công.
    // Kết nối lại trước mỗi lần gửi để outbox không bị kẹt nếu Kafka khởi động sau Order Service.
    private async ensureConnected(): Promise<void> {
        if (this.connected) return;
        if (!this.connecting) {
            this.connecting = this.producer
                .connect()
                .then(() => {
                    this.connected = true;
                })
                .finally(() => {
                    this.connecting = undefined;
                });
        }
        await this.connecting;
    }

    // Có timeout để dispatcher trả bản ghi về PENDING thay vì giữ PROCESSING vô hạn khi broker không phản hồi.
    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
    ): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(`Kafka publish timeout after ${timeoutMs}ms`),
                    ),
                timeoutMs,
            );
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async publish(
        topic: string,
        payload: unknown,
        aggregateKey: string,
    ): Promise<boolean> {
        try {
            await this.withTimeout(
                (async () => {
                    await this.ensureConnected();
                    return this.producer.send({
                        topic,
                        messages: [
                            {
                                key: aggregateKey,
                                value: JSON.stringify(payload),
                            },
                        ],
                    });
                })(),
                Number(
                    this.config.get<string>(
                        'KAFKA_PUBLISH_TIMEOUT_MS',
                        '10000',
                    ),
                ),
            );
            return true;
        } catch (error) {
            this.connected = false;
            this.logger.error(
                `Failed to publish to topic "${topic}": ${String(error)}`,
            );
            return false;
        }
    }
}
