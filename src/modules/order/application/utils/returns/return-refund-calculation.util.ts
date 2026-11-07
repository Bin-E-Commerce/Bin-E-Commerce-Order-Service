// Các phép tính hoàn hàng thuần dùng chung cho request mới và request được customer sửa.

import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { toCents } from '@/modules/order/application/utils/money/order-money.util';
import type { ReturnRefundCalculationOrderSnapshot } from '@/modules/order/application/types/returns/return-refund-calculation.type';

// Xác định nhóm lỗi sản phẩm do shop chịu phí vận chuyển đầu ra.
export function isSellerReturnFaultReason(reason: OrderReturnReason): boolean {
    return [
        OrderReturnReason.DAMAGED,
        OrderReturnReason.WRONG_ITEM,
        OrderReturnReason.MISSING_ITEM,
        OrderReturnReason.NOT_AS_DESCRIBED,
    ].includes(reason);
}

// Giữ chính sách payer thống nhất: lỗi hàng do shop, đổi ý do khách, OTHER chờ shop phân loại.
export function getFixedReturnShippingPayer(
    reason: OrderReturnReason,
): 'CUSTOMER' | 'SELLER' | null {
    if (isSellerReturnFaultReason(reason)) return 'SELLER';
    if (reason === OrderReturnReason.CHANGE_OF_MIND) return 'CUSTOMER';
    return null;
}

// Hoàn phí giao đầu ra theo tỷ trọng giá trị item của shop để tránh hoàn trùng khi order nhiều shop.
export function calculateReturnShippingRefund(
    order: ReturnRefundCalculationOrderSnapshot,
    itemAmount: bigint,
    reason: OrderReturnReason,
    shopId: string,
): bigint {
    if (!isSellerReturnFaultReason(reason)) return 0n;
    const subtotal = toCents(order.subtotal);
    const breakdown = (order.shippingFeeBreakdown ?? []).find(
        (entry) => String(entry.shopId ?? '') === shopId,
    );
    const shippingFee =
        breakdown?.fee !== undefined
            ? toCents(String(breakdown.fee))
            : toCents(order.shippingFee);
    if (subtotal <= 0n || shippingFee <= 0n) return 0n;

    const shopItems = (order.items ?? []).filter(
        (item) => item.sellerShopId === shopId,
    );
    const shopSubtotal = shopItems.reduce(
        (sum, item) => sum + toCents(item.lineTotal),
        0n,
    );
    const allocationBase =
        breakdown?.fee !== undefined && shopSubtotal > 0n
            ? shopSubtotal
            : subtotal;
    const cappedItemAmount =
        itemAmount > allocationBase ? allocationBase : itemAmount;
    const proportionalAmount =
        (shippingFee * cappedItemAmount + allocationBase / 2n) / allocationBase;
    return roundReturnVnd(proportionalAmount);
}

// Làm tròn tiền VND về đồng để mọi nguồn hiển thị cùng một snapshot.
export function roundReturnVnd(value: bigint): bigint {
    return ((value + 50n) / 100n) * 100n;
}

// Giới hạn khoản hoàn không âm và không vượt tổng tiền order đã thu.
export function capReturnRefundAmount(
    value: bigint,
    originalOrderAmount?: string | null,
): bigint {
    const nonNegativeValue = value > 0n ? value : 0n;
    if (!originalOrderAmount) return nonNegativeValue;
    const maximumRefundable = toCents(originalOrderAmount);
    return nonNegativeValue > maximumRefundable
        ? maximumRefundable
        : nonNegativeValue;
}
