// File này cung cấp healthcheck HTTP, không đọc hoặc thay đổi dữ liệu đơn hàng.

import { Controller, Get } from "@nestjs/common";
import { DataSource } from "typeorm";

// Trả trạng thái process và database để container orchestration biết service đã sẵn sàng chưa.
@Controller("health")
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  // Kiểm tra kết nối database hiện tại mà không chạy query nghiệp vụ.
  @Get()
  getHealth(): { status: string; database: string } {
    return {
      status: "ok",
      database: this.dataSource.isInitialized ? "up" : "down",
    };
  }
}
