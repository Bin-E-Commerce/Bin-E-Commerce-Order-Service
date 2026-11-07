// Adapter này giữ truy vấn và transaction khi customer sửa return request còn chờ shop.

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import type { ReturnRequestEditRepositoryPort } from '@/modules/order/application/contracts/return-request-edit.repository';
import type {
    ReturnRequestEditSnapshot,
    ReturnRequestEditWrite,
    ReturnRequestEditWriteResult,
} from '@/modules/order/application/types/returns/return-request-edit.type';

@Injectable()
export class ReturnRequestEditRepository implements ReturnRequestEditRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Đọc snapshot chỉ sau khi xác minh request và order cùng thuộc customer hiện tại.
    async findForCustomerEdit(
        ownerId: string,
        returnId: string,
    ): Promise<ReturnRequestEditSnapshot | null> {
        const request = await this.dataSource
            .getRepository(OrderReturnRequest)
            .findOne({ where: { id: returnId, ownerId } });
        if (!request) return null;

        const order = await this.dataSource.getRepository(Order).findOne({
            where: { id: request.orderId, ownerId },
            relations: { items: true },
        });
        if (!order) return null;

        return {
            id: request.id,
            orderId: request.orderId,
            orderNumber: order.orderNumber,
            ownerId: request.ownerId,
            shopId: request.shopId,
            sellerUserId: request.sellerUserId,
            status: request.status,
            updatedAt: request.updatedAt.toISOString(),
            itemIds: request.itemIds,
            reason: request.reason,
            description: request.description,
            evidence: request.evidence ?? [],
            refundItemAmount: request.refundItemAmount,
            returnShippingEstimatedCost: request.returnShippingEstimatedCost,
            order: {
                totalAmount: order.totalAmount,
                subtotal: order.subtotal,
                shippingFee: order.shippingFee,
                shippingFeeBreakdown: order.shippingFeeBreakdown,
                items: (order.items ?? []).map((item) => ({
                    id: item.id,
                    sellerShopId: item.sellerShopId,
                    lineTotal: item.lineTotal,
                })),
            },
        };
    }

    // Khóa row để chặn seller duyệt đồng thời; updatedAt làm optimistic version chống ghi đè form cũ.
    async updateRequested(
        input: ReturnRequestEditWrite,
    ): Promise<ReturnRequestEditWriteResult> {
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(OrderReturnRequest);
            const request = await repository.findOne({
                where: { id: input.returnId, ownerId: input.ownerId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request) return { kind: 'NOT_FOUND' };
            if (request.status !== OrderReturnStatus.REQUESTED)
                return { kind: 'NOT_EDITABLE' };
            if (
                request.updatedAt.toISOString() !==
                new Date(input.expectedUpdatedAt).toISOString()
            )
                return { kind: 'STALE' };
            const order = await manager.getRepository(Order).findOne({
                where: { id: request.orderId, ownerId: input.ownerId },
            });
            if (!order) return { kind: 'NOT_FOUND' };

            request.reason = input.reason;
            request.description = input.description;
            request.evidence = input.evidence;
            request.refundItemAmount = input.refundItemAmount;
            request.refundShippingAmount = input.refundShippingAmount;
            request.estimatedRefundAmount = input.estimatedRefundAmount;
            request.refundAmount = input.estimatedRefundAmount;
            request.returnShippingPayer = input.returnShippingPayer;
            // Force một version mới kể cả khi hai thao tác rơi cùng một mili-giây.
            request.updatedAt = new Date(
                Math.max(Date.now(), request.updatedAt.getTime() + 1),
            );
            const saved = await repository.save(request);
            return {
                kind: 'UPDATED',
                snapshot: {
                    id: saved.id,
                    orderId: saved.orderId,
                    orderNumber: order.orderNumber,
                    ownerId: saved.ownerId,
                    shopId: saved.shopId,
                    sellerUserId: saved.sellerUserId,
                    status: saved.status,
                    refundAmount: saved.refundAmount,
                    reason: saved.reason,
                    description: saved.description,
                    updatedAt: saved.updatedAt.toISOString(),
                },
            };
        });
    }
}
