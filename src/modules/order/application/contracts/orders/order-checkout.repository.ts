// Cổng lưu checkout atomically để application layer không phụ thuộc TypeORM hoặc entity outbox.

import type { Order } from '@/database/order/entities/order.entity';
import type { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import type {
    CartCheckoutItemSelection,
    CheckoutQuoteItem,
} from '@/modules/order/application/types/order/external-contracts.type';

export const ORDER_CHECKOUT_REPOSITORY = Symbol('ORDER_CHECKOUT_REPOSITORY');

export interface PersistOrderCheckoutInput {
    orderNumber: string;
    ownerId: string;
    paymentMethod: PaymentMethod;
    isSandbox: boolean;
    checkoutCartItemId: string | null;
    checkoutCartItemIds: string[] | null;
    shippingAddressId: string;
    shippingAddress: Record<string, unknown>;
    items: CheckoutQuoteItem[];
    cartCheckoutItems: CartCheckoutItemSelection[];
    shippingFee: string;
    shippingFeeBreakdown: Array<Record<string, unknown>>;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
}

export interface OrderCheckoutRepositoryPort {
    // Lưu order, item snapshot, audit history và cart cleanup outbox trong cùng transaction.
    persistCheckout(input: PersistOrderCheckoutInput): Promise<Order>;
}
