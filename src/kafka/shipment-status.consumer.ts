// File này consume shipment.status.updated để Order Service đồng bộ toàn bộ mốc vận chuyển từ Shipping Service.
// Consumer dùng group versioned để có thể replay event lịch sử sau khi bổ sung logic đồng bộ, đồng thời giữ handler idempotent.

import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer } from 'kafkajs';
import type { ShipmentStatusUpdatedEvent } from '@common/kafka/events/shipping.events';
import { OrderDeliveryConfirmationService } from '@/modules/order/application/services/delivery/order-delivery-confirmation.service';

@Injectable()
export class ShipmentStatusConsumer implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ShipmentStatusConsumer.name);
    private readonly consumer: Consumer;
    private readonly reconnectDelayMs = 5000;
    private isStopping = false;

    constructor(
        private readonly config: ConfigService,
        private readonly deliveryConfirmation: OrderDeliveryConfirmationService,
    ) {
        const kafka = new Kafka({
            clientId: this.config.get<string>(
                'KAFKA_CLIENT_ID',
                'order-service',
            ),
            brokers: this.config
                .get<string>('KAFKA_BROKERS', 'localhost:29092')
                .split(',')
                .map((broker) => broker.trim())
                .filter(Boolean),
            retry: { retries: 3 },
        });
        this.consumer = kafka.consumer({
            groupId: this.config.get<string>(
                'KAFKA_ORDER_GROUP_ID',
                'order-service-shipment-sync-v3',
            ),
        });
    }

    // Khởi chạy consumer nền để HTTP vẫn sẵn sàng và consumer tự thử lại nếu Kafka/topic khởi động chậm.
    async onModuleInit(): Promise<void> {
        void this.connectWithRetry();
    }

    // Thử kết nối lại khi Kafka chưa quảng bá topic-partition lúc Order Service khởi động.
    private async connectWithRetry(): Promise<void> {
        while (!this.isStopping) {
            try {
                await this.consumer.connect();
                await this.consumer.subscribe({
                    topic: 'shipment.status.updated',
                    fromBeginning: true,
                });
                await this.consumer.run({
                    eachMessage: async ({ message }) =>
                        this.handleMessage(message.value?.toString()),
                });
                this.logger.log('Shipment status consumer connected');
                return;
            } catch (error) {
                this.logger.warn(
                    `Shipment status consumer connect failed; retrying in ${this.reconnectDelayMs}ms: ${String(error)}`,
                );
                await this.consumer.disconnect().catch(() => undefined);
                await this.waitBeforeReconnect();
            }
        }
    }

    // Chờ giữa các lần thử để tránh tạo vòng lặp reconnect liên tục khi hạ tầng chưa sẵn sàng.
    private async waitBeforeReconnect(): Promise<void> {
        await new Promise<void>((resolve) =>
            setTimeout(resolve, this.reconnectDelayMs),
        );
    }

    // Đánh dấu dừng trước khi đóng consumer để retry nền không kết nối lại trong lúc Nest shutdown.
    async onModuleDestroy(): Promise<void> {
        this.isStopping = true;
        await this.consumer.disconnect().catch(() => undefined);
    }

    // Parse envelope an toàn rồi ủy quyền mọi trạng thái cho application service có transaction, khóa pessimistic và chống replay.
    private async handleMessage(raw: string | undefined): Promise<void> {
        if (!raw) return;
        try {
            const event = JSON.parse(raw) as ShipmentStatusUpdatedEvent;
            if (!event.data?.orderId) return;
            await this.deliveryConfirmation.syncShipmentStatus(
                event.data.orderId,
                event.data.status,
                event.occurredAt,
            );
        } catch (error) {
            this.logger.error(
                `Không thể xử lý shipment status event: ${String(error)}`,
            );
        }
    }
}
