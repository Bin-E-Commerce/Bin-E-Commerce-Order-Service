// File này chuyển order đã commit thành integration event cho Notification Service.
// Service chỉ phát recipient đã được Product Service xác định bằng sellerOwnerId, không tự tin shopId từ browser.

import { Injectable } from "@nestjs/common";
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderEventItem,
  OrderEvents,
} from "../../../../../../packages/common/kafka/events/order.events";
import { KafkaProducerService } from "../../../kafka/kafka-producer.service";
import { Order } from "../../../database/entities/order.entity";
import { fromCents, toCents } from "../utils/order-money.util";

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
  constructor(private readonly kafkaProducer: KafkaProducerService) {}

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
