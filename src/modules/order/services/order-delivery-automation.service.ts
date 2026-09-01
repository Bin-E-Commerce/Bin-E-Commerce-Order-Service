// File này chạy vòng quét nhẹ cho các order đã hết thời hạn customer xác nhận nhận hàng.
// Worker không chứa nghiệp vụ chuyển trạng thái; nó chỉ lấy batch nhỏ và ủy quyền transaction cho OrderDeliveryConfirmationService.

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OrderRepository } from "../repositories/order.repository";
import { OrderDeliveryConfirmationService } from "./order-delivery-confirmation.service";

@Injectable()
export class OrderDeliveryAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderDeliveryAutomationService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly deliveryConfirmation: OrderDeliveryConfirmationService,
  ) {}

  // Khởi động worker sau khi Nest đã dựng xong dependency graph và không chặn HTTP server.
  onModuleInit(): void {
    this.timer = setInterval(() => void this.processExpiredOrders(), 60_000);
    void this.processExpiredOrders();
  }

  // Dừng timer khi Nest shutdown để dev watch không giữ process và không tạo batch mới trong lúc đóng app.
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // Lấy tối đa 50 order mỗi vòng rồi để transaction từng order tự kiểm tra lại deadline và issue đang mở.
  private async processExpiredOrders(): Promise<void> {
    try {
      const orders = await this.orderRepository.findExpiredDeliveryConfirmations(new Date());
      await Promise.all(orders.map((order) => this.deliveryConfirmation.autoComplete(order.id)));
    } catch (error) {
      this.logger.error(`Không thể auto-complete order hết hạn: ${String(error)}`);
    }
  }
}
