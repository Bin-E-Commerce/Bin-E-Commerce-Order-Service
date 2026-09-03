// File này map persistence model thành response order ổn định cho frontend và API consumer.

import { Injectable } from "@nestjs/common";
import { Order } from "../../../../../database/order/entities/order.entity";
import { OrderFulfillmentStatus } from "../../../../../database/order/enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../../../../../database/order/enums/payment-status.enum";
import { OrderDeliveryConfirmationStatus } from "../../../../../database/delivery/enums/order-delivery-confirmation-status.enum";
import { OrderStatus } from "../../../../../database/order/enums/order-status.enum";
import { fromCents, toCents } from "../../utils/order-money.util";
import type {
  OrderResponse,
  SellerOrderListItemResponse,
  SellerOrderResponse,
} from "../../types/order-response.type";

// Không leak idempotency key, fingerprint hay ownerId ra public response.
@Injectable()
export class OrderResponseMapper {
  // Map aggregate đã load relations thành response chỉ đọc.
  toResponse(order: Order, warnings: string[] = []): OrderResponse {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentStatus:
        order.fulfillmentStatus ?? this.legacyFulfillment(order.status),
      paymentStatus:
        order.paymentStatus ?? PaymentStatus.COD_PENDING_COLLECTION,
      paymentMethod: order.paymentMethod,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      shippingFeeBreakdown: order.shippingFeeBreakdown ?? [],
      totalAmount: order.totalAmount,
      note: order.note,
      shippingAddress: order.shippingAddress,
      items: (order.items ?? []).map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        sellerShopId: item.sellerShopId,
        sku: item.sku,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      cancelReason: order.cancelReason,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      statusHistory: [...(order.statusHistory ?? [])]
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .map((history) => ({
          id: history.id,
          fromStatus: history.fromStatus,
          toStatus: history.toStatus,
          reason: history.reason,
          createdAt: history.createdAt.toISOString(),
        })),
      warnings,
      createdAt: order.createdAt.toISOString(),
      completedAt: order.completedAt?.toISOString() ?? null,
      deliveryConfirmation: {
        status: order.deliveryConfirmationStatus ?? OrderDeliveryConfirmationStatus.PENDING,
        method: order.deliveryConfirmationMethod ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        deadline: order.deliveryConfirmationDeadline?.toISOString() ?? null,
      },
    };
  }

  // Map summary Seller chỉ lấy item thuộc shop đã được repository lọc sẵn và tính tổng bằng tiền snapshot.
  toSellerListItem(order: Order): SellerOrderListItemResponse {
    const items = order.items ?? [];
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentStatus:
        order.fulfillmentStatus ?? this.legacyFulfillment(order.status),
      paymentStatus:
        order.paymentStatus ?? PaymentStatus.COD_PENDING_COLLECTION,
      paymentMethod: order.paymentMethod,
      shopItemTotal: this.sumLineTotals(items),
      shippingFee: order.shippingFee,
      shippingFeeBreakdown: order.shippingFeeBreakdown ?? [],
      itemCount: items.reduce((count, item) => count + item.quantity, 0),
      previewItems: items.slice(0, 2).map((item) => ({
        productId: item.productId,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      createdAt: order.createdAt.toISOString(),
    };
  }

  // Map detail Seller mà không trả ownerId, SKU hoặc item của shop khác dù entity có thể chứa toàn bộ order.
  toSellerResponse(order: Order): SellerOrderResponse {
    const items = order.items ?? [];
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentStatus:
        order.fulfillmentStatus ?? this.legacyFulfillment(order.status),
      paymentStatus:
        order.paymentStatus ?? PaymentStatus.COD_PENDING_COLLECTION,
      paymentMethod: order.paymentMethod,
      shopItemTotal: this.sumLineTotals(items),
      shippingFee: order.shippingFee,
      shippingFeeBreakdown: order.shippingFeeBreakdown ?? [],
      shippingAddress: order.shippingAddress,
      items: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      cancelReason: order.cancelReason,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      statusHistory: [...(order.statusHistory ?? [])]
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .map((history) => ({
          id: history.id,
          fromStatus: history.fromStatus,
          toStatus: history.toStatus,
          reason: history.reason,
          createdAt: history.createdAt.toISOString(),
        })),
      createdAt: order.createdAt.toISOString(),
    };
  }

  // Cộng lineTotal từ Product snapshot để Seller không nhìn thấy tổng tiền toàn bộ order nhiều shop.
  private sumLineTotals(items: Array<{ lineTotal: string }>): string {
    return fromCents(
      items.reduce((total, item) => total + toCents(item.lineTotal), 0n),
    );
  }

  // Map dữ liệu Phase 1-3 chưa có cột mới để response vẫn ổn định trong lúc migration chạy dần.
  private legacyFulfillment(status: OrderStatus): OrderFulfillmentStatus {
    if (status === OrderStatus.CANCELLED)
      return OrderFulfillmentStatus.CANCELLED;
    if (status === OrderStatus.FAILED)
      return OrderFulfillmentStatus.DELIVERY_FAILED;
    return OrderFulfillmentStatus.TO_SHIP;
  }
}
