// Adapter giữ khóa và cập nhật đồng bộ return request, order cùng delivery issue liên quan.

import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderDeliveryIssue } from '@/database/delivery/entities/order-delivery-issue.entity';
import { OrderDeliveryConfirmationStatus } from '@/database/delivery/enums/order-delivery-confirmation-status.enum';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import {
    ACTIVE_ORDER_RETURN_STATUSES,
    OrderReturnStatus,
} from '@/database/returns/enums/order-return-status.enum';
import type { ReturnRequestCancellationRepositoryPort } from '@/modules/order/application/contracts/return-request-cancellation.repository';
import type {
    ReturnRequestCancellationResult,
    ReturnRequestCancellationSnapshot,
} from '@/modules/order/application/types/returns/return-request-cancellation.type';

// Transaction boundary đồng bộ request return, delivery issue và order khi khách hủy hoặc shop từ chối yêu cầu.
@Injectable()
export class ReturnRequestCancellationRepository implements ReturnRequestCancellationRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Khóa request trước order theo thứ tự transition hiện có; retry request đã hủy cũng có thể đồng bộ order cũ bị kẹt.
    // Chỉ khôi phục mốc giao ban đầu sau khi mọi return kết thúc; request hủy không làm lùi đơn đã xác nhận.
    async cancelRequested(
        ownerId: string,
        returnId: string,
    ): Promise<ReturnRequestCancellationResult> {
        return this.dataSource.transaction(async (manager) => {
            const requestRepository = manager.getRepository(OrderReturnRequest);
            const request = await requestRepository.findOne({
                where: { id: returnId, ownerId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request) return { kind: 'NOT_FOUND' };

            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository
                .createQueryBuilder('order')
                .where('order.id = :orderId', { orderId: request.orderId })
                .andWhere('order.owner_id = :ownerId', { ownerId })
                .setLock('pessimistic_write')
                .getOne();
            if (!order) return { kind: 'NOT_FOUND' };

            const wasAlreadyCancelled =
                request.status === OrderReturnStatus.CUSTOMER_CANCELLED;
            if (
                request.status !== OrderReturnStatus.REQUESTED &&
                !wasAlreadyCancelled
            )
                return { kind: 'NOT_CANCELLABLE' };

            // Giữ idempotency cho request đã hủy; chỉ request REQUESTED mới ghi status lần đầu.
            let savedRequest = request;
            if (!wasAlreadyCancelled) {
                request.status = OrderReturnStatus.CUSTOMER_CANCELLED;
                savedRequest = await requestRepository.save(request);
            }
            const linkedIssue = await manager
                .getRepository(OrderDeliveryIssue)
                .findOne({
                    where: {
                        orderId: order.id,
                        ownerId,
                        returnRequestId: request.id,
                    },
                    lock: { mode: 'pessimistic_write' },
                });

            // Request đã ở trạng thái hủy nên active-check chỉ còn các yêu cầu khác của cùng order.
            const restoredDelivery =
                await this.restoreDeliveryIfNoActiveReturns(manager, order);

            if (restoredDelivery && linkedIssue) {
                // Giữ issue cũ để audit; liên kết có thể thiếu ở dữ liệu legacy nhưng order vẫn cần được mở lại.
                linkedIssue.resolutionNote =
                    'Khách đã hủy yêu cầu hoàn hàng; đơn đang chờ xác nhận nhận hàng hoặc gửi yêu cầu mới.';
                await manager
                    .getRepository(OrderDeliveryIssue)
                    .save(linkedIssue);
            }

            // Retry đã hủy không phát event trùng; phần phục hồi order phía trên vẫn được chạy idempotent.
            if (wasAlreadyCancelled) return { kind: 'ALREADY_CANCELLED' };

            return {
                kind: 'CANCELLED',
                snapshot: this.toSnapshot(savedRequest, order.orderNumber),
            };
        });
    }

    // Shop từ chối return thì khôi phục mốc giao ban đầu nếu không còn return nào khác đang chạy.
    async restoreDeliveryAfterRejectedRequest(
        ownerId: string,
        returnId: string,
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const requestRepository = manager.getRepository(OrderReturnRequest);
            const request = await requestRepository.findOne({
                where: { id: returnId, ownerId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request || request.status !== OrderReturnStatus.REJECTED)
                return;

            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository.findOne({
                where: { id: request.orderId, ownerId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!order) return;
            await this.restoreDeliveryIfNoActiveReturns(manager, order);
        });
    }

    // Khôi phục delivery sau khi hết return active; giữ COMPLETED đã xác nhận, còn issue chưa chốt thì mở lại PENDING.
    private async restoreDeliveryIfNoActiveReturns(
        manager: EntityManager,
        order: Order,
    ): Promise<boolean> {
        if (order.fulfillmentStatus !== OrderFulfillmentStatus.RETURN_REFUND)
            return false;

        // Return theo nhiều shop có thể chạy song song; một request kết thúc không được làm rời luồng của request còn mở.
        const activeRequests = await manager
            .getRepository(OrderReturnRequest)
            .find({
                where: {
                    orderId: order.id,
                    ownerId: order.ownerId,
                    status: In([...ACTIVE_ORDER_RETURN_STATUSES]),
                },
                select: { id: true },
            });
        if (activeRequests.length > 0) return false;

        // ISSUE_REPORTED chưa chứng minh khách chấp nhận hàng; completion marker chỉ có hiệu lực nếu không còn issue đó.
        const hasUnresolvedIssue =
            order.deliveryConfirmationStatus ===
            OrderDeliveryConfirmationStatus.ISSUE_REPORTED;
        const wasDeliveryConfirmed =
            !hasUnresolvedIssue &&
            ([
                OrderDeliveryConfirmationStatus.CONFIRMED,
                OrderDeliveryConfirmationStatus.AUTO_CONFIRMED,
            ].includes(order.deliveryConfirmationStatus) ||
                Boolean(order.completedAt));

        if (wasDeliveryConfirmed) {
            order.fulfillmentStatus = OrderFulfillmentStatus.COMPLETED;
        } else {
            order.fulfillmentStatus = OrderFulfillmentStatus.DELIVERED;
            order.deliveryConfirmationStatus =
                OrderDeliveryConfirmationStatus.PENDING;
            order.deliveryConfirmationMethod = null;
            order.deliveryConfirmedAt = null;
            order.completedAt = null;
        }

        // Chỉ lưu sau active-check và khi RETURN_REFUND cần phục hồi, tránh ghi đè order đã đổi trạng thái.
        await manager.getRepository(Order).save(order);
        return true;
    }

    // Chỉ trả các trường cần để phát sự kiện hủy, không đưa entity persistence ra application boundary.
    private toSnapshot(
        request: OrderReturnRequest,
        orderNumber: string,
    ): ReturnRequestCancellationSnapshot {
        return {
            id: request.id,
            orderId: request.orderId,
            orderNumber,
            ownerId: request.ownerId,
            shopId: request.shopId,
            sellerUserId: request.sellerUserId,
            status: request.status,
            refundAmount: request.refundAmount,
            reason: request.reason as OrderReturnReason,
            reviewNote: request.reviewNote,
        };
    }
}
