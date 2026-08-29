// File này gom endpoint health độc lập để Docker và monitoring kiểm tra service.

import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

// Health module không phụ thuộc business module để vẫn có thể khởi động tối thiểu.
@Module({ controllers: [HealthController] })
export class HealthModule {}
