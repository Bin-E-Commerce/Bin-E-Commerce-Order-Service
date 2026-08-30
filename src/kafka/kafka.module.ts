// File này đăng ký Kafka producer dùng chung trong Order Service.
// Kafka là kênh thông báo best-effort; nghiệp vụ order vẫn có database làm nguồn sự thật.

import { Global, Module } from "@nestjs/common";
import { KafkaProducerService } from "./kafka-producer.service";

@Global()
@Module({
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
