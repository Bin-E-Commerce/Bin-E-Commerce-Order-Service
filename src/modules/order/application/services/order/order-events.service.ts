// File này chuyển order đã commit thành integration event cho Notification Service.
// Service chỉ phát recipient đã được Product Service xác định bằng sellerOwnerId, không tự tin shopId từ browser.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Repository } from "typeorm";
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
import { OrderFulfillmentStatus } from "../../../../../database/order/enums/order-fulfillment-status.enum";
import { OrderPurchaseEventOutboxEntity } from "../../../../../database/integration/entities/order-purchase-event-outbox.entity";

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
export class OrderEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderEventsService.name);
  private dispatchTimer?: NodeJS.Timeout;

  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly dataSource: DataSource,
    @Optional()
    @InjectRepository(Order)
    private readonly orderRepository?: Repository<Order>,
    @Optional()
    @InjectRepository(OrderPurchaseEventOutboxEntity)
    private readonly purchaseOutboxRepository?: Repository<OrderPurchaseEventOutboxEntity>,
  ) {}

  // Khởi động dispatcher để purchase outbox tiếp tục được gửi sau khi Kafka phục hồi.
  onModuleInit(): void {
    this.dispatchTimer = setInterval(
      () => void this.dispatchPendingSafe(),
      5000,
    );
    void this.dispatchPendingSafe();
  }

  // Dừng polling khi shutdown để test/watch mode không giữ process sống.
  onModuleDestroy(): void {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
  }

  // Replay completed purchase theo trang; eventId publishPurchaseCompleted ổn định nên downstream idempotent.
  async replayCompletedPurchases(
    page: number,
    pageSize: number,
  ): Promise<{
    page: number;
    pageSize: number;
    total: number;
    published: number;
  }> {
    if (!this.orderRepository)
      return { page, pageSize, total: 0, published: 0 };
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const [orders, total] = await this.orderRepository.findAndCount({
      where: { fulfillmentStatus: OrderFulfillmentStatus.COMPLETED },
      relations: { items: true },
      order: { id: "ASC" },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    });
    for (const order of orders) await this.publishPurchaseCompleted(order.id);
    return {
      page: safePage,
      pageSize: safePageSize,
      total,
      published: orders.length,
    };
  }

  // Ghi completed event vào outbox; caller truyền manager khi trạng thái order cũng đang trong transaction.
  async enqueuePurchaseCompleted(
    orderId: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (!this.orderRepository || !this.purchaseOutboxRepository) return;
    const enqueue = async (
      transactionManager: EntityManager,
    ): Promise<void> => {
      const order = await transactionManager.getRepository(Order).findOne({
        where: { id: orderId },
        relations: { items: true },
      });
      if (!order) return;
      const event = this.toPurchaseEvent(
        order,
        OrderEvents.PURCHASE_COMPLETED,
        order.id,
      );
      await transactionManager
        .getRepository(OrderPurchaseEventOutboxEntity)
        .createQueryBuilder()
        .insert()
        .into(OrderPurchaseEventOutboxEntity)
        .values({
          eventId: event.eventId,
          topic: event.eventName,
          aggregateId: event.aggregateId,
          payload: event,
          status: "PENDING",
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .orIgnore()
        .execute();
    };
    if (manager) {
      await enqueue(manager);
      return;
    }
    await this.dataSource.transaction(enqueue);
  }

  // Tương thích với caller cũ; event đã bền vững trong outbox rồi mới thử gửi ngay.
  async publishPurchaseCompleted(orderId: string): Promise<void> {
    await this.enqueuePurchaseCompleted(orderId);
    await this.dispatchPendingSafe();
  }

  // Phát tín hiệu item đã hoàn về sau inspection để Recommendation trừ preference, không tính lại sản phẩm bị trả.
  async publishPurchaseReturned(
    orderId: string,
    returnId: string,
    itemIds: string[],
    manager?: EntityManager,
  ): Promise<void> {
    if (
      !this.orderRepository ||
      !this.purchaseOutboxRepository ||
      itemIds.length === 0
    )
      return;
    const enqueue = async (
      transactionManager: EntityManager,
    ): Promise<void> => {
      const order = await transactionManager.getRepository(Order).findOne({
        where: { id: orderId },
        relations: { items: true },
      });
      if (!order) return;
      const selectedIds = new Set(itemIds);
      const event = this.toPurchaseEvent(
        order,
        OrderEvents.PURCHASE_RETURNED,
        returnId,
        selectedIds,
      );
      await transactionManager
        .getRepository(OrderPurchaseEventOutboxEntity)
        .createQueryBuilder()
        .insert()
        .into(OrderPurchaseEventOutboxEntity)
        .values({
          eventId: event.eventId,
          topic: event.eventName,
          aggregateId: event.aggregateId,
          payload: event,
          status: "PENDING",
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .orIgnore()
        .execute();
    };
    if (manager) {
      // Khi đang ở source transaction, chỉ ghi outbox; dispatcher chỉ được gửi sau commit.
      await enqueue(manager);
      return;
    }
    await this.dataSource.transaction(enqueue);
    await this.dispatchPendingSafe();
  }

  // Chuẩn hóa purchase event từ order snapshot và chỉ chọn item hợp lệ khi có return correction.
  private toPurchaseEvent(
    order: Order,
    eventName: OrderPurchaseEvent["eventName"],
    aggregateId: string,
    selectedItemIds?: Set<string>,
  ): OrderPurchaseEvent {
    const occurredAt =
      eventName === OrderEvents.PURCHASE_COMPLETED
        ? (order.completedAt?.toISOString() ?? new Date().toISOString())
        : new Date().toISOString();
    return {
      eventId: `${eventName}:${aggregateId}`,
      eventName,
      eventVersion: 1,
      source: "order-service",
      occurredAt,
      aggregateId,
      data: {
        orderId: order.id,
        customerUserId: order.ownerId,
        occurredAt,
        items: (order.items ?? [])
          .filter((item) => !selectedItemIds || selectedItemIds.has(item.id))
          .map((item) => ({
            orderItemId: item.id,
            productId: item.productId,
            variantId: item.variantId,
            categoryId: item.categoryId ?? null,
            quantity: item.quantity,
          })),
      },
    };
  }

  // Claim tối đa 20 outbox row bằng SKIP LOCKED để nhiều replica gửi song song mà không gửi trùng do cạnh tranh claim.
  private async dispatchPending(): Promise<void> {
    if (!this.purchaseOutboxRepository) return;
    await this.purchaseOutboxRepository.query(
      `UPDATE order_purchase_event_outbox
          SET status = 'PENDING', updated_at = now()
        WHERE status = 'PROCESSING' AND updated_at < now() - INTERVAL '1 minute'`,
    );
    const claimed = (await this.purchaseOutboxRepository.query(
      `WITH claimed AS (
         SELECT event_id FROM order_purchase_event_outbox
         WHERE status = 'PENDING' AND available_at <= now()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 20
       )
       UPDATE order_purchase_event_outbox outbox
          SET status = 'PROCESSING', updated_at = now()
         FROM claimed
        WHERE outbox.event_id = claimed.event_id
      RETURNING outbox.event_id`,
    )) as Array<{ event_id: string }>;
    if (claimed.length === 0) return;
    const rows = await this.purchaseOutboxRepository.find({
      where: { eventId: In(claimed.map((row) => row.event_id)) },
      order: { createdAt: "ASC" },
    });
    for (const row of rows) {
      const published = await this.kafkaProducer.publish(
        row.topic,
        row.payload,
        row.aggregateId,
      );
      if (published) {
        await this.purchaseOutboxRepository.update(
          { eventId: row.eventId },
          {
            status: "PUBLISHED",
            publishedAt: new Date(),
            updatedAt: new Date(),
          },
        );
      } else {
        const attemptCount = row.attemptCount + 1;
        const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10));
        await this.purchaseOutboxRepository.update(
          { eventId: row.eventId },
          {
            status: "PENDING",
            attemptCount,
            availableAt: new Date(Date.now() + delaySeconds * 1000),
            updatedAt: new Date(),
          },
        );
      }
    }
  }

  // Bọc lỗi dispatcher để Kafka/database tạm lỗi không làm unhandled rejection trong Nest process.
  private async dispatchPendingSafe(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch (error) {
      this.logger.warn(
        `Order purchase outbox deferred: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
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
    await this.publishDeliveryEvent(
      OrderEvents.DELIVERY_AWAITING_CONFIRMATION,
      orderId,
      "PENDING",
    );
  }

  // Phát tín hiệu audit khi khách chủ động xác nhận đã nhận hàng; review vẫn là thao tác tùy chọn ở Product Service.
  async publishDeliveryConfirmed(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(
      OrderEvents.DELIVERY_CONFIRMED,
      orderId,
      "CONFIRMED",
    );
  }

  // Phát tín hiệu khi khách báo vấn đề để notification/support workflow có thể tiếp nhận mà không đổi review thành khiếu nại.
  async publishDeliveryIssueReported(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(
      OrderEvents.DELIVERY_ISSUE_REPORTED,
      orderId,
      "ISSUE_REPORTED",
    );
  }

  // Phát tín hiệu riêng cho auto-complete để downstream biết order hoàn tất do hết hạn chứ không phải customer click.
  async publishDeliveryAutoConfirmed(orderId: string): Promise<void> {
    await this.publishDeliveryEvent(
      OrderEvents.DELIVERY_AUTO_CONFIRMED,
      orderId,
      "AUTO_CONFIRMED",
    );
  }

  // Chuẩn hóa envelope delivery event và giữ eventId ổn định để consumer downstream chống duplicate.
  private async publishDeliveryEvent(
    topic: string,
    orderId: string,
    status: string,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    await this.kafkaProducer.publish(
      topic,
      {
        eventId: `${topic}:${orderId}`,
        eventName: topic,
        eventVersion: 1,
        source: "order-service",
        occurredAt,
        aggregateId: orderId,
        data: { orderId, status },
      },
      orderId,
    );
  }

  // Gom item theo chủ shop để một order nhiều shop tạo đúng một notification/email cho từng seller.
  // EventId ổn định theo orderId giúp Notification Service chống duplicate khi Kafka redeliver event.
  async publishCreated(
    order: Order,
    items: SellerRecipientSource[],
    customerEmail?: string,
  ): Promise<void> {
    const recipients = this.groupSellerRecipients(items);

    const occurredAt =
      order.createdAt?.toISOString() ?? new Date().toISOString();
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
    const cancelledAt =
      order.cancelledAt?.toISOString() ?? new Date().toISOString();
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
  private toEventRecipients(recipients: Map<string, GroupedSellerRecipient>) {
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
