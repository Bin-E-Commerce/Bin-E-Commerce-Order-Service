// File này quản lý một Kafka producer cho các integration event của Order Service.
// Producer không làm rollback order khi broker tạm thời lỗi; lỗi được log để nghiệp vụ checkout không bị gián đoạn.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Producer } from "kafkajs";

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: Producer;

  // Khởi tạo producer theo brokers từ environment để local và production dùng chung một adapter.
  constructor(private readonly config: ConfigService) {
    const brokers = this.config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean);

    const kafka = new Kafka({
      clientId: this.config.get<string>("KAFKA_CLIENT_ID", "order-service"),
      brokers,
      retry: { retries: 3 },
    });

    this.producer = kafka.producer();
  }

  // Kết nối Kafka khi service khởi động nhưng không chặn HTTP server nếu broker local chưa chạy.
  async onModuleInit(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.log("Kafka producer connected");
    } catch (error) {
      this.logger.warn(`Kafka producer connect failed (non-fatal): ${String(error)}`);
    }
  }

  // Đóng producer khi Nest shutdown để dev watch không giữ connection cũ.
  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect().catch(() => void 0);
  }

  // Gửi event theo aggregate key để các thay đổi của cùng order giữ đúng thứ tự trong Kafka partition.
  async publish(topic: string, payload: unknown, aggregateKey: string): Promise<void> {
    try {
      await this.producer.send({
        topic,
        messages: [{ key: aggregateKey, value: JSON.stringify(payload) }],
      });
    } catch (error) {
      this.logger.error(`Failed to publish to topic "${topic}": ${String(error)}`);
    }
  }
}
