// File này điều phối xác nhận nhận hàng, delivery issue và tự hoàn tất order sau deadline.
// Service là ranh giới duy nhất được phép đổi fulfillment từ DELIVERED sang COMPLETED; mọi request đều khóa order để chống double-click và worker chạy trùng.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderDeliveryIssue } from "../../../database/entities/order-delivery-issue.entity";
import { OrderItem } from "../../../database/entities/order-item.entity";
import { OrderDeliveryConfirmationMethod } from "../../../database/enums/order-delivery-confirmation-method.enum";
import { OrderDeliveryConfirmationStatus } from "../../../database/enums/order-delivery-confirmation-status.enum";
import { OrderDeliveryIssueStatus } from "../../../database/enums/order-delivery-issue-status.enum";
import { OrderFulfillmentStatus } from "../../../database/enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../../../database/enums/payment-status.enum";
import { OrderRepository } from "../repositories/order.repository";
import { OrderResponseMapper } from "./order-response-mapper.service";
import { OrderEventsService } from "./order-events.service";
import type { ShipmentStatus } from "../../../../../../packages/common/kafka/events/shipping.events";
import {
  DeliveryConfirmationDecision,
  DeliveryConfirmationDto,
} from "../dto/delivery-confirmation.dto";

const AUTO_CONFIRMATION_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

const SHIPMENT_STAGE_BY_STATUS: Partial<
  Record<ShipmentStatus, OrderFulfillmentStatus>
> = {
  READY_TO_SHIP: OrderFulfillmentStatus.TO_SHIP,
  PICKUP_ASSIGNED: OrderFulfillmentStatus.TO_SHIP,
  PICKED_UP: OrderFulfillmentStatus.TO_SHIP,
  IN_TRANSIT: OrderFulfillmentStatus.SHIPPING,
  FAILED: OrderFulfillmentStatus.DELIVERY_FAILED,
  CANCELLED: OrderFulfillmentStatus.CANCELLED,
};

const FULFILLMENT_STAGE_RANK: Record<OrderFulfillmentStatus, number> = {
  [OrderFulfillmentStatus.TO_SHIP]: 1,
  [OrderFulfillmentStatus.SHIPPING]: 2,
  [OrderFulfillmentStatus.DELIVERED]: 3,
  [OrderFulfillmentStatus.COMPLETED]: 4,
  [OrderFulfillmentStatus.DELIVERY_FAILED]: 5,
  [OrderFulfillmentStatus.CANCELLED]: 5,
  [OrderFulfillmentStatus.RETURN_REFUND]: 5,
};

@Injectable()
export class OrderDeliveryConfirmationService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly responseMapper: OrderResponseMapper,
    private readonly orderEvents: OrderEventsService,
    private readonly dataSource: DataSource,
  ) {}

  // Ghi nhận DELIVERED từ Shipping, mở cửa sổ ba ngày và phát event sau khi transaction commit.
  // Event có thể được gửi lại nhiều lần nên chỉ request đầu tiên được đổi trạng thái; các lần sau trả về order hiện tại.
  async markDelivered(orderId: string, occurredAt: string): Promise<void> {
    let changed = false;
    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .where("order.id = :orderId", { orderId })
        .setLock("pessimistic_write")
        .getOne();
      if (!order) return;
      if (
        order.fulfillmentStatus === OrderFulfillmentStatus.COMPLETED ||
        order.fulfillmentStatus === OrderFulfillmentStatus.DELIVERED ||
        order.fulfillmentStatus === OrderFulfillmentStatus.RETURN_REFUND ||
        order.deliveryConfirmationStatus === OrderDeliveryConfirmationStatus.ISSUE_REPORTED
      ) {
        return;
      }

      const deliveredAt = this.parseOccurredAt(occurredAt);
      order.fulfillmentStatus = OrderFulfillmentStatus.DELIVERED;
      order.deliveredAt = deliveredAt;
      order.deliveryConfirmationStatus = OrderDeliveryConfirmationStatus.PENDING;
      order.deliveryConfirmationMethod = null;
      order.deliveryConfirmationDeadline = new Date(deliveredAt.getTime() + AUTO_CONFIRMATION_DELAY_MS);
      order.deliveryConfirmedAt = null;
      await manager.getRepository(Order).save(order);
      changed = true;
    });

    if (changed) await this.orderEvents.publishDeliveryAwaitingConfirmation(orderId);
  }

  // Đồng bộ mọi mốc vận chuyển về Order Service để danh sách, tab và màn hình chi tiết cùng dùng một trạng thái nghiệp vụ.
  // DELIVERED đi qua markDelivered để mở cửa sổ xác nhận ba ngày; các mốc khác chỉ được tiến về phía trước,
  // tránh event Kafka cũ làm đơn hàng đã giao quay ngược lại TO_SHIP/SHIPPING khi consumer replay lịch sử.
  async syncShipmentStatus(
    orderId: string,
    shipmentStatus: ShipmentStatus,
    occurredAt: string,
  ): Promise<void> {
    if (shipmentStatus === "DELIVERED") {
      await this.markDelivered(orderId, occurredAt);
      return;
    }

    const nextStage = SHIPMENT_STAGE_BY_STATUS[shipmentStatus];
    if (!nextStage) return;

    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .where("order.id = :orderId", { orderId })
        .setLock("pessimistic_write")
        .getOne();
      if (!order) return;

      // Các trạng thái đã hoàn tất, hủy hoặc đang xử lý khiếu nại không được phép bị event vận chuyển cũ ghi đè.
      if (
        order.fulfillmentStatus === OrderFulfillmentStatus.COMPLETED ||
        order.fulfillmentStatus === OrderFulfillmentStatus.RETURN_REFUND ||
        order.deliveryConfirmationStatus === OrderDeliveryConfirmationStatus.ISSUE_REPORTED
      ) {
        return;
      }

      const currentRank = FULFILLMENT_STAGE_RANK[order.fulfillmentStatus];
      const nextRank = FULFILLMENT_STAGE_RANK[nextStage];
      if (nextRank <= currentRank) return;

      order.fulfillmentStatus = nextStage;
      await manager.getRepository(Order).save(order);
    });
  }

  // Xử lý quyết định của customer trong một transaction khóa order và issue liên quan.
  // RECEIVED hoàn tất order ngay; ISSUE_REPORTED giữ order ở DELIVERED để return/support có thời gian xử lý và chặn auto-complete.
  async confirm(ownerId: string, orderId: string, dto: DeliveryConfirmationDto) {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");

    let eventStatus: "confirmed" | "issue" | null = null;
    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .where("order.id = :orderId", { orderId })
        .andWhere("order.owner_id = :ownerId", { ownerId })
        .setLock("pessimistic_write")
        .getOne();
      if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");

      if (
        dto.decision === DeliveryConfirmationDecision.RECEIVED &&
        (order.fulfillmentStatus === OrderFulfillmentStatus.COMPLETED ||
          order.deliveryConfirmationStatus === OrderDeliveryConfirmationStatus.AUTO_CONFIRMED)
      ) {
        return;
      }
      if (order.fulfillmentStatus !== OrderFulfillmentStatus.DELIVERED) {
        throw new ConflictException("Đơn hàng chưa ở trạng thái chờ xác nhận.");
      }

      if (dto.decision === DeliveryConfirmationDecision.RECEIVED) {
        order.fulfillmentStatus = OrderFulfillmentStatus.COMPLETED;
        order.paymentStatus = PaymentStatus.PAID;
        order.deliveryConfirmationStatus = OrderDeliveryConfirmationStatus.CONFIRMED;
        order.deliveryConfirmationMethod = OrderDeliveryConfirmationMethod.CUSTOMER;
        order.deliveryConfirmedAt = new Date();
        order.completedAt = order.deliveryConfirmedAt;
        await manager.getRepository(Order).save(order);
        eventStatus = "confirmed";
        return;
      }

      if (!dto.reason) throw new BadRequestException("Vui lòng chọn lý do đơn hàng có vấn đề.");
      const itemIds = dto.itemIds ?? [];
      // Đọc item sau khi đã khóa order; tránh LEFT JOIN trong câu lệnh FOR UPDATE khiến PostgreSQL từ chối khóa phía nullable.
      const orderItems = await manager.getRepository(OrderItem).find({
        where: { orderId },
      });
      const orderItemIds = new Set(orderItems.map((item) => item.id));
      if (itemIds.some((itemId) => !orderItemIds.has(itemId))) {
        throw new BadRequestException("Sản phẩm báo lỗi không thuộc đơn hàng.");
      }

      const issueRepository = manager.getRepository(OrderDeliveryIssue);
      const existingIssue = await issueRepository.findOne({
        where: { orderId, status: OrderDeliveryIssueStatus.OPEN },
      });
      if (existingIssue) return;

      await issueRepository.save(
        issueRepository.create({
          orderId,
          ownerId,
          reason: dto.reason,
          itemIds,
          note: dto.note?.trim() || null,
          status: OrderDeliveryIssueStatus.OPEN,
          returnRequestId: null,
          resolvedAt: null,
          resolutionNote: null,
        }),
      );
      order.deliveryConfirmationStatus = OrderDeliveryConfirmationStatus.ISSUE_REPORTED;
      await manager.getRepository(Order).save(order);
      eventStatus = "issue";
    });

    if (eventStatus === "confirmed") await this.orderEvents.publishDeliveryConfirmed(orderId);
    if (eventStatus === "issue") await this.orderEvents.publishDeliveryIssueReported(orderId);

    const order = await this.orderRepository.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    return this.responseMapper.toResponse(order);
  }

  // Worker gọi hàm này cho từng order hết hạn; transaction kiểm tra lại deadline để request cạnh tranh không thể hoàn tất sai.
  async autoComplete(orderId: string): Promise<boolean> {
    let changed = false;
    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .where("order.id = :orderId", { orderId })
        .setLock("pessimistic_write")
        .getOne();
      if (!order) return;
      if (
        order.fulfillmentStatus !== OrderFulfillmentStatus.DELIVERED ||
        order.deliveryConfirmationStatus !== OrderDeliveryConfirmationStatus.PENDING ||
        !order.deliveryConfirmationDeadline ||
        order.deliveryConfirmationDeadline > new Date()
      ) {
        return;
      }

      order.fulfillmentStatus = OrderFulfillmentStatus.COMPLETED;
      order.paymentStatus = PaymentStatus.PAID;
      order.deliveryConfirmationStatus = OrderDeliveryConfirmationStatus.AUTO_CONFIRMED;
      order.deliveryConfirmationMethod = OrderDeliveryConfirmationMethod.AUTO;
      order.deliveryConfirmedAt = new Date();
      order.completedAt = order.deliveryConfirmedAt;
      await manager.getRepository(Order).save(order);
      changed = true;
    });

    if (changed) await this.orderEvents.publishDeliveryAutoConfirmed(orderId);
    return changed;
  }

  // Chuyển timestamp từ provider về Date hợp lệ; timestamp lỗi không được phép tạo deadline sai.
  private parseOccurredAt(value: string): Date {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}
