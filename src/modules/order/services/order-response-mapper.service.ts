// File này map persistence model thành response order ổn định cho frontend và API consumer.

import { Injectable } from "@nestjs/common";
import { Order } from "../../../database/entities/order.entity";
import type { OrderResponse } from "../types/order-response.type";

// Không leak idempotency key, fingerprint hay ownerId ra public response.
@Injectable()
export class OrderResponseMapper {
  // Map aggregate đã load relations thành response chỉ đọc.
  toResponse(order: Order, warnings: string[] = []): OrderResponse {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentMethod: order.paymentMethod,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
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
    };
  }
}
