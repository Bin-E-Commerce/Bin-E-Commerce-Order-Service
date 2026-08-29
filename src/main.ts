// File này khởi động Order Service, cấu hình HTTP, validation và Swagger.
// File không chứa nghiệp vụ checkout; các quyết định tạo đơn nằm trong module order.
// ValidationPipe là ranh giới đầu vào duy nhất trước khi request đi vào application service.

import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";

// Khởi động HTTP server với validation chặt để payload lạ không lọt vào use case.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const config = app.get(ConfigService);
  const isDev = config.get<string>("NODE_ENV") !== "production";
  const port = config.get<number>("PORT", 3011);

  app.use(helmet());
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors({ origin: false });

  if (isDev) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Bin E-Commerce — Order Service")
        .setDescription("Checkout and order lifecycle APIs")
        .setVersion("1.0")
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup("docs", app, document);
  }

  app.enableShutdownHooks();
  await app.listen(port);
  console.log(`[order-service] Running on port ${port}`);
}

void bootstrap();
