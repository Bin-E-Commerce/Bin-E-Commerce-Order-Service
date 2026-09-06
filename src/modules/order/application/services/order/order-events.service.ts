// File này chuyển order đã commit thành integration event cho Notification Service.
// Service chỉ phát recipient đã được Product Service xác định bằng sellerOwnerId, không tự tin shopId từ browser.

import { Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderEventItem,
  OrderEvents,
} from "@common/kafka/events/order.events";
import type { ReturnChangedEvent } from "@common/kafka/events/order.events";
import { KafkaProducerService } from "../../../../../kafka/kafka-producer.service";
import { Order } from "../../../../../database/order/entities/order.entity";
import { fromCents, toCents } from "../../utils/order-money.util";
import type { OrderPurchaseEvent } from "@common/kafka/events/order.events";

type SellerRecipientSource = {
  sellerOwnerId?: string | null;
  sellerShopId?: string | null;
  quantity: number;
  lineTotal: string;
  productName: string;
  variantName?: string;
  imageUrl?: string | null;
  unitPrice?: string;
};

type GroupedSellerRecipient = {
  userId: string;
  shopId: string;
  itemCount: number;
  totalCents: bigint;
  previewProductName: string;
};

@Injectable()
export class OrderEventsService {
  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    @Optional() @InjectRepository(Order) private readonly orderRepository?: Repository<Order>,
  ) {}

  // Phát purchase completed sau khi order đã hoàn tất; Recommendation chỉ dùng event này làm positive signal.
  async publishPurchaseCompleted(orderId: string): Promise<void> {
    if (!this.orderRepository) return;
    const order = await this.orderRepository.findOne({ where: { id: orderId }, relations: { items: true } });
    if (!order) return;
    const eventName = OrderEvents.PURCHASE_COMPLETED;
    const event: OrderPurchaseEvent = {
      eventId: `${eventName}:${order.id}`,
      eventName,
      eventVersion: 1,
      source: "order-service",
      occurredAt: order.completedAt?.toISOString() ?? new Date().toISOString(),
      aggregateId: order.id,
      data: {
        orderId: order.id,
        customerUserId: order.ownerId,
        occurredAt: order.completedAt?.toISOString() ?? new Date().toISOString(),
        items: (order.items ?? []).map((item) => ({
          orderItemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          categoryId: null,
          quantity: item.quantity,
        })),
      },
    };
    await this.kafkaProducer.publish(eventName, event, order.id);
  }

  // Phát tín hiệu item đã hoàn về sau inspection để Recommendation trừ preference, không tính lại sản phẩm bị trả.
  async publishPurchaseReturned(orderId: string, returnId: string, itemIds: string[]): Promise<void> {
    if (!this.orderRepository || itemIds.length === 0) return;
    const order = await this.orderRepository.findOne({ where: { id: orderId }, relations: { items: true } });
    if (!order) return;
    const selectedIds = new Set(itemIds);
    const eventName = OrderEvents.PURCHASE_RETURNED;
    const occurredAt = new Date().toISOString();
    const event: OrderPurchaseEvent = {
      eventId: `${eventName}:${returnId}`,
      eventName,
      eventVersion: 1,
      source: "order-service",
      occurredAt,
      aggregateId: returnId,
      data: {
        orderId: order.id,
        customerUserId: order.ownerId,
        occurredAt,
        items: (order.items ?? [])
          .filter((item) => selectedIds.has(item.id))
          .map((item) => ({
            orderItemId: item.id,
            productId: item.productId,
            variantId: item.variantId,
            categoryId: null,
            quantity: item.quantity,
          })),
      },
    };
    await this.kafkaProducer.publish(eventName, event, returnId);
  }

  // Phát sự kiện return sau khi transaction đã commit; Notification Service dùng eventId ổn định để chống trùng.
  async publishReturnChanged(input: {
    eventName: ReturnChangedEvent["eventName"];
    returnId: string;
    orderId: string;
    orderNumber: string;
    shopId: string;
    customerUserId: string;
    sellerUserId: string | null;
    status: string;
    refundAmount: string;
    reason: string;
    note: string | null;
  }): Promise<void> {
    const event: ReturnChangedEvent = {
      eventId: `${input.eventName}:${input.returnId}:${input.status}`,
      eventName: input.eventName,
      eventVersion: 1,
      source: "order-service",
      occurredAt: new Date().toISOString(),
      aggregateId: input.returnId,
      data: {
        returnId: input.returnId,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        shopId: input.shopId,
        customerUserId: input.customerUserId,
        sellerUserId: input.sellerUserId,
        status: input.status,
        refundAmount: input.refundAmount,
        reason: input.reason,
        note: input.note,
      },
    };
    await this.kafkaProducer.publish(input.eventName, event, input.returnId);
  }

  // Phát tín hiệu để Notification Service nhắc khách xác nhận sau khi Shipping báo giao thành công.
  async publishDeliveryAwaitingConfirmation(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(OrderEvents.DELIVERY_AWAITING_CONFIRMATION, orderId, "PENDING");
  }

  // Phát tín hiệu audit khi khách chủ động xác nhận đã nhận hàng; review vẫn là thao tác tùy chọn ở Product Service.
  async publishDeliveryConfirmed(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(OrderEvents.DELIVERY_CONFIRMED, orderId, "CONFIRMED");
  }

  // Phát tín hiệu khi khách báo vấn đề để notification/support workflow có thể tiếp nhận mà không đổi review thành khiếu nại.
  async publishDeliveryIssueReported(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(OrderEvents.DELIVERY_ISSUE_REPORTED, orderId, "ISSUE_REPORTED");
  }

  // Phát tín hiệu riêng cho auto-complete để downstream biết order hoàn tất do hết hạn chứ không phải customer click.
  async publishDeliveryAutoConfirmed(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(OrderEvents.DELIVERY_AUTO_CONFIRMED, orderId, "AUTO_CONFIRMED");
  }

  // Chuẩn hóa envelope delivery event và giữ eventId ổn định để consumer downstream chống duplicate.
  private async publishDeliveryEvent(topic: string, orderId: string, status: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    await this.kafkaProducer.publish(topic, {
      eventId: `${topic}:${orderId}`,
      eventName: topic,
      eventVersion: 1,
      source: "order-service",
      occurredAt,
      aggregateId: orderId,
      data: { orderId, status },
    }, orderId);
  }

  // Gom item theo chủ shop để một order nhiều shop tạo đúng một notification/email cho từng seller.
  // EventId ổn định theo orderId giúp Notification Service chống duplicate khi Kafka redeliver event.
  async publishCreated(
    order: Order,
    items: SellerRecipientSource[],
    customerEmail?: string,
  ): Promise<void> {
    const recipients = this.groupSellerRecipients(items);

    const occurredAt = order.createdAt?.toISOString() ?? new Date().toISOString();
    const event: OrderCreatedEvent = {
      eventId: `order-created:${order.id}`,
      eventName: OrderEvents.CREATED,
      eventVersion: 1,
      source: "order-service",
      occurredAt,
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentMethod: "COD",
        totalAmount: order.totalAmount,
        createdAt: occurredAt,
        customerUserId: order.ownerId,
        customerEmail: customerEmail ?? null,
        customerItems: this.toEventItems(items),
        recipients: this.toEventRecipients(recipients),
      },
    };

    await this.kafkaProducer.publish(OrderEvents.CREATED, event, order.id);
  }

  // Phát event sau khi transaction hủy đã commit để customer và các seller nhận cùng một kết quả cuối cùng.
  async publishCancelled(order: Order, customerEmail?: string): Promise<void> {
    const recipients = this.groupSellerRecipients(
      (order.items ?? []).map((item) => ({
        sellerOwnerId: item.sellerOwnerId,
        sellerShopId: item.sellerShopId,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        productName: item.productName,
      })),
    );
    const cancelledAt = order.cancelledAt?.toISOString() ?? new Date().toISOString();
    const event: OrderCancelledEvent = {
      eventId: `order-cancelled:${order.id}`,
      eventName: OrderEvents.CANCELLED,
      eventVersion: 1,
      source: "order-service",
      occurredAt: cancelledAt,
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentMethod: "COD",
        totalAmount: order.totalAmount,
        createdAt: order.createdAt?.toISOString() ?? cancelledAt,
        cancelledAt,
        cancelReason: order.cancelReason,
        customerUserId: order.ownerId,
        customerEmail: customerEmail ?? null,
        customerItems: this.toEventItems(order.items ?? []),
        recipients: this.toEventRecipients(recipients),
      },
    };

    await this.kafkaProducer.publish(OrderEvents.CANCELLED, event, order.id);
  }

  // Chuẩn hóa item snapshot của order về cùng shape với quote để không nhân đôi thuật toán gom seller.
  private groupSellerRecipients(
    items: SellerRecipientSource[],
  ): Map<string, GroupedSellerRecipient> {
    const recipients = new Map<string, GroupedSellerRecipient>();

    for (const item of items) {
      if (!item.sellerOwnerId || !item.sellerShopId) continue;

      const key = `${item.sellerOwnerId}:${item.sellerShopId}`;
      const current = recipients.get(key);
      if (current) {
        current.itemCount += item.quantity;
        current.totalCents += toCents(item.lineTotal);
        continue;
      }

      recipients.set(key, {
        userId: item.sellerOwnerId,
        shopId: item.sellerShopId,
        itemCount: item.quantity,
        totalCents: toCents(item.lineTotal),
        previewProductName: item.productName,
      });
    }

    return recipients;
  }

  // Chuyển Map nội bộ thành payload bất biến và chỉ giữ tổng hợp cần cho notification/email.
  private toEventRecipients(
    recipients: Map<string, GroupedSellerRecipient>,
  ) {
    return [...recipients.values()].map((recipient) => ({
      userId: recipient.userId,
      shopId: recipient.shopId,
      itemCount: recipient.itemCount,
      shopItemTotal: fromCents(recipient.totalCents),
      previewProductName: recipient.previewProductName,
    }));
  }

  // Chuyển snapshot sản phẩm thành contract email, giữ nguyên giá và ảnh tại thời điểm checkout.
  private toEventItems(items: SellerRecipientSource[]): OrderEventItem[] {
    return items.map((item) => ({
      productName: item.productName,
      variantName: item.variantName ?? "",
      imageUrl: item.imageUrl ?? null,
      unitPrice: item.unitPrice ?? item.lineTotal,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    }));
  }
}
