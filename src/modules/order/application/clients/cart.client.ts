// Client này gọi Cart Service qua HTTP nội bộ.
// Order Service chỉ đọc active cart và yêu cầu chuyển cart sang CHECKED_OUT sau khi order đã lưu.
// Không gọi qua API Gateway để tránh vòng proxy và không query database Cart trực tiếp.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    CheckoutResourceNotFoundError,
    OrderDependencyUnavailableError,
} from '@/modules/order/application/errors/order.errors';
import type { ActiveCartResponse } from '@/modules/order/application/types/external-contracts.type';

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
    // itemId có mặt khi Mua ngay; Cart Service sẽ xác thực ownership rồi chỉ trả đúng dòng đó.
    async getActiveCart(
        ownerId: string,
        itemId?: string,
    ): Promise<ActiveCartResponse> {
        const query = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
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

    // Thực hiện request nội bộ và trả cả status để application service quyết định lỗi nghiệp vụ.
    private async request<T>(
        path: string,
        method: 'GET' | 'POST',
        ownerId: string,
    ): Promise<{ ok: boolean; status: number; data: T }> {
        try {
            const response = await fetch(`${this.targetBase}${path}`, {
                method,
                signal: AbortSignal.timeout(5000),
                headers: {
                    accept: 'application/json',
                    'x-user-id': ownerId,
                    'x-internal-service-token': this.internalToken,
                },
            });
            const data = (await response.json().catch(() => ({}))) as T;
            return { ok: response.ok, status: response.status, data };
        } catch {
            throw new OrderDependencyUnavailableError('Cart Service');
        }
    }
}
