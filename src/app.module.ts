// File này khai báo dependency graph của Order Service.
// Database chỉ chứa aggregate Order và không tạo foreign key sang service khác.
// Migrations là nguồn schema duy nhất; synchronize luôn bị tắt để bảo vệ production.

import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HealthModule } from "./modules/health/health.module";
import { OrderModule } from "./modules/order/order.module";
import { KafkaModule } from "./kafka/kafka.module";

// Lắp các module hạ tầng và bounded context vào một dependency graph rõ ràng.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        host: config.get<string>("POSTGRES_HOST", "localhost"),
        port: config.get<number>("POSTGRES_PORT", 5432),
        username: config.get<string>("POSTGRES_USER"),
        password: config.get<string>("POSTGRES_PASSWORD"),
        database: config.get<string>("POSTGRES_DB"),
        entities: [__dirname + "/**/*.entity{.ts,.js}"],
        migrations: [__dirname + "/database/migrations/*{.ts,.js}"],
        // Cho phép migration enum commit trước migration chuẩn hóa dữ liệu cũ.
        migrationsTransactionMode: "each" as const,
        migrationsRun: true,
        synchronize: false,
        ssl:
          config.get<string>("NODE_ENV") === "production"
            ? { rejectUnauthorized: false }
            : false,
        logging: config.get<string>("TYPEORM_LOGGING", "false") === "true",
      }),
    }),
    HealthModule,
    KafkaModule,
    OrderModule,
  ],
})
export class AppModule {}
