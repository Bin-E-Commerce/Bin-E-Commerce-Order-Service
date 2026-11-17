// Client này gọi Cart Service qua HTTP nội bộ.
// Order Service chỉ đọc active cart và yêu cầu chuyển cart sang CHECKED_OUT sau khi order đã lưu.
// Không gọi qua API Gateway để tránh vòng proxy và không query database Cart trực tiếp.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    CheckoutResourceNotFoundError,
    OrderDependencyUnavailableError,
} from '@/modules/order/application/errors/order.errors';
import type {
    ActiveCartResponse,
    CartCheckoutItemSelection,
} from '@/modules/order/application/types/order/external-contracts.type';

// Đóng gói URL, token và mapping lỗi của Cart Service ở một adapter duy nhất.
@Injectable()
export class CartClient {
    private readonly targetBase: string;
    private readonly internalToken: string;

    // Đọc cấu hình bằng ConfigService để local/Docker/production dùng cùng contract.
    constructor(private readonly config: ConfigService) {
        this.targetBase = config.get<string>(
            'CART_SERVICE_URL',
            'http://localhost:3003',
        );
        this.internalToken = config.get<string>('INTERNAL_SERVICE_TOKEN', '');
    }

    // Lấy cart active đúng owner; endpoint không tự tạo cart rỗng để checkout không che lỗi nghiệp vụ.
    // Sau khi chọn ID, kiểm tra response đúng chính xác tập đó để service cũ không âm thầm trả toàn cart.
    async getActiveCart(
        ownerId: string,
        itemIds?: string[],
    ): Promise<ActiveCartResponse> {
        const query = itemIds?.length
            ? `?itemIds=${encodeURIComponent(itemIds.join(','))}`
            : '';
        const response = await this.request<ActiveCartResponse>(
            `/api/v1/internal/carts/active${query}`,
            'GET',
            ownerId,
        );
        if (response.status === 404) {
            throw new CheckoutResourceNotFoundError(
                'Không tìm thấy giỏ hàng đang hoạt động.',
            );
        }
        if (!response.ok)
            throw new OrderDependencyUnavailableError('Cart Service');
        if (itemIds?.length) {
            const expectedIds = new Set(itemIds);
            const returnedIds = response.data?.items?.map((item) => item.id);
            // Fail closed khi Cart Service chưa hỗ trợ selection hoặc trả dư/thiếu item.
            if (
                !returnedIds ||
                returnedIds.length !== expectedIds.size ||
                new Set(returnedIds).size !== expectedIds.size ||
                returnedIds.some((itemId) => !expectedIds.has(itemId))
            ) {
                throw new OrderDependencyUnavailableError('Cart Service');
            }
        }
        return response.data;
    }

    // Đóng cart sau khi order đã commit; request này chỉ thao tác cart của owner từ header nội bộ.
    async checkoutCart(ownerId: string, itemId?: string): Promise<void> {
        const path = itemId
            ? `/api/v1/internal/carts/checkout-item?itemId=${encodeURIComponent(itemId)}`
            : '/api/v1/internal/carts/checkout';
        const response = await this.request<{ status: string }>(
            path,
            'POST',
            ownerId,
        );
        if (!response.ok)
            throw new OrderDependencyUnavailableError('Cart Service');
    }

    // Gửi snapshot số lượng cùng order ID để Cart dọn đúng phần đã mua và nhận diện retry idempotently.
    async checkoutCartItems(
        ownerId: string,
        orderId: string,
        items: CartCheckoutItemSelection[],
    ): Promise<void> {
        const response = await this.request<{ status: string }>(
            '/api/v1/internal/carts/checkout-items',
            'POST',
            ownerId,
            { orderId, items },
        );
        if (!response.ok)
            throw new OrderDependencyUnavailableError('Cart Service');
    }

    // Đóng cart full legacy chỉ khi Cart xác nhận chưa có thay đổi kể từ lúc order được tạo.
    async checkoutLegacyCartBefore(
        ownerId: string,
        orderId: string,
        checkoutAllBefore: string,
    ): Promise<void> {
        const response = await this.request<{ status: string }>(
            '/api/v1/internal/carts/checkout-items',
            'POST',
            ownerId,
            { orderId, checkoutAllBefore },
        );
        if (!response.ok)
            throw new OrderDependencyUnavailableError('Cart Service');
    }

    // Giữ đường lui cho Pay2S order cũ chỉ lưu ID; request vẫn mang orderId chống cleanup lặp.
    async checkoutCartItemIds(
        ownerId: string,
        orderId: string,
        itemIds: string[],
        checkoutAllBefore?: string,
    ): Promise<void> {
        const response = await this.request<{ status: string }>(
            '/api/v1/internal/carts/checkout-items',
            'POST',
            ownerId,
            {
                orderId,
                itemIds,
                ...(checkoutAllBefore ? { checkoutAllBefore } : {}),
            },
        );
        if (!response.ok)
            throw new OrderDependencyUnavailableError('Cart Service');
    }

    // Thực hiện request nội bộ và trả cả status để application service quyết định lỗi nghiệp vụ.
    private async request<T>(
        path: string,
        method: 'GET' | 'POST',
        ownerId: string,
        body?: unknown,
    ): Promise<{ ok: boolean; status: number; data: T }> {
        try {
            const response = await fetch(`${this.targetBase}${path}`, {
                method,
                signal: AbortSignal.timeout(5000),
                headers: {
                    accept: 'application/json',
                    'x-user-id': ownerId,
                    'x-internal-service-token': this.internalToken,
                    ...(body ? { 'content-type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const data = (await response.json().catch(() => ({}))) as T;
            return { ok: response.ok, status: response.status, data };
        } catch {
            throw new OrderDependencyUnavailableError('Cart Service');
        }
    }
}
