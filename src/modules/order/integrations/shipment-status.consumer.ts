// File này consume shipment.status.updated để Order Service đồng bộ toàn bộ mốc vận chuyển từ Shipping Service.
// Consumer dùng group versioned để có thể replay event lịch sử sau khi bổ sung logic đồng bộ, đồng thời giữ handler idempotent.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Consumer } from "kafkajs";
import type { ShipmentStatusUpdatedEvent } from "../../../../../../packages/common/kafka/events/shipping.events";
import { OrderDeliveryConfirmationService } from "../services/order-delivery-confirmation.service";

@Injectable()
export class ShipmentStatusConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShipmentStatusConsumer.name);
  private readonly consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    private readonly deliveryConfirmation: OrderDeliveryConfirmationService,
  ) {
    const kafka = new Kafka({
      clientId: this.config.get<string>("KAFKA_CLIENT_ID", "order-service"),
      brokers: this.config
        .get<string>("KAFKA_BROKERS", "localhost:29092")
        .split(",")
        .map((broker) => broker.trim())
        .filter(Boolean),
      retry: { retries: 3 },
    });
    this.consumer = kafka.consumer({
      groupId: this.config.get<string>(
        "KAFKA_ORDER_GROUP_ID",
        "order-service-shipment-sync-v2",
      ),
    });
  }

  // Subscribe topic sau khi app khởi động; lỗi kết nối được log để không làm HTTP checkout bị sập theo Kafka.
  async onModuleInit(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: "shipment.status.updated",
        fromBeginning: true,
      });
      await this.consumer.run({
        eachMessage: async ({ message }) =>
          this.handleMessage(message.value?.toString()),
      });
      this.logger.log("Shipment status consumer connected");
    } catch (error) {
      this.logger.warn(
        `Shipment status consumer connect failed (non-fatal): ${String(error)}`,
      );
    }
  }

  // Disconnect consumer khi Nest shutdown để không giữ socket Kafka và không tạo process treo trong dev.
  async onModuleDestroy(): Promise<void> {
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
