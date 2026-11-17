// Repository này sở hữu transaction ghi order checkout và các dữ liệu cần commit cùng order.

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderCartCleanupOutboxEntity } from '@/database/integration/entities/order-cart-cleanup-outbox.entity';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import type { OrderCheckoutRepositoryPort } from '@/modules/order/application/contracts/orders/order-checkout.repository';
import type { PersistOrderCheckoutInput } from '@/modules/order/application/contracts/orders/order-checkout.repository';
import { PAY2S_ORDER_PAYMENT_TTL_MS } from '@/modules/order/application/constants/payments/pay2s.constants';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';

@Injectable()
export class OrderCheckoutRepository implements OrderCheckoutRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Transaction giữ aggregate, item, audit và cleanup outbox đồng bộ; rollback toàn bộ nếu một phần ghi thất bại.
    async persistCheckout(input: PersistOrderCheckoutInput): Promise<Order> {
        return this.dataSource.transaction(async (manager) => {
            const orderRepository = manager.getRepository(Order);
            const subtotalCents = input.items.reduce(
                (total, item) =>
                    total + toCents(item.unitPrice) * BigInt(item.quantity),
                0n,
            );
            const subtotal = fromCents(subtotalCents);
            // Pay2S chờ IPN, COD được xác nhận để đi tiếp quy trình giao hàng.
            const initialStatus =
                input.paymentMethod === PaymentMethod.PAY2S
                    ? OrderStatus.PENDING
                    : OrderStatus.CONFIRMED;
            const order = orderRepository.create({
                orderNumber: input.orderNumber,
                ownerId: input.ownerId,
                status: initialStatus,
                fulfillmentStatus: OrderFulfillmentStatus.TO_SHIP,
                paymentStatus:
                    input.paymentMethod === PaymentMethod.PAY2S
                        ? PaymentStatus.PENDING
                        : PaymentStatus.COD_PENDING_COLLECTION,
                paymentMethod: input.paymentMethod,
                paymentExpiresAt:
                    input.paymentMethod === PaymentMethod.PAY2S
                        ? new Date(Date.now() + PAY2S_ORDER_PAYMENT_TTL_MS)
                        : null,
                checkoutCartItemId: input.checkoutCartItemId,
                checkoutCartItemIds: input.checkoutCartItemIds,
                isSandbox: input.isSandbox,
                shippingAddressId: input.shippingAddressId,
                shippingAddress: input.shippingAddress,
                subtotal,
                shippingFee: input.shippingFee,
                shippingFeeBreakdown: input.shippingFeeBreakdown,
                totalAmount: fromCents(
                    toCents(subtotal) + toCents(input.shippingFee),
                ),
                note: input.note,
                cancelReason: null,
                cancelledAt: null,
                idempotencyKey: input.idempotencyKey,
                requestFingerprint: input.requestFingerprint,
            });
            const savedOrder = await orderRepository.save(order);

            const itemRepository = manager.getRepository(OrderItem);
            const orderItems = input.items.map((item) =>
                itemRepository.create({
                    orderId: savedOrder.id,
                    productId: item.productId,
                    variantId: item.variantId,
                    categoryId: item.categoryId,
                    // Reservation cũ có thể thiếu brand; null giữ backward compatibility thay vì đoán từ catalog.
                    brandId: item.brandId ?? null,
                    sellerShopId: item.sellerShopId,
                    sellerOwnerId: item.sellerOwnerId,
                    sku: item.sku,
                    productName: item.productName,
                    variantName: item.variantName,
                    imageUrl: item.imageUrl,
                    unitPrice: item.unitPrice,
                    quantity: item.quantity,
                    lineTotal: fromCents(
                        toCents(item.unitPrice) * BigInt(item.quantity),
                    ),
                    packageWeightGrams: item.packageWeightGrams,
                    packageLengthCm: String(item.packageLengthCm),
                    packageWidthCm: String(item.packageWidthCm),
                    packageHeightCm: String(item.packageHeightCm),
                }),
            );
            await itemRepository.save(orderItems);

            // Outbox commit nguyên tử với order; worker chỉ gửi cleanup khi payment đã được xác nhận.
            await manager.getRepository(OrderCartCleanupOutboxEntity).insert({
                orderId: savedOrder.id,
                ownerId: input.ownerId,
                items: input.cartCheckoutItems,
                cleanupMode: 'SNAPSHOT',
                cleanupBefore: null,
                status: 'PENDING',
                attemptCount: 0,
                availableAt: new Date(),
                lastError: null,
            });

            await manager.getRepository(OrderStatusHistory).save(
                manager.getRepository(OrderStatusHistory).create({
                    orderId: savedOrder.id,
                    fromStatus: null,
                    toStatus: initialStatus,
                    reason:
                        input.paymentMethod === PaymentMethod.PAY2S
                            ? 'Checkout Pay2S đang chờ xác nhận thanh toán.'
                            : 'Checkout COD đã xác nhận và giữ tồn kho thành công.',
                }),
            );

            savedOrder.items = orderItems;
            return savedOrder;
        });
    }
}
