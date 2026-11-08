// Adapter giữ khóa và cập nhật đồng bộ return request, order cùng delivery issue liên quan.

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

// Transaction boundary cho phép customer hủy và khôi phục order mà không để hai trạng thái lệch nhau.
@Injectable()
export class ReturnRequestCancellationRepository implements ReturnRequestCancellationRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Khóa request trước order theo thứ tự transition hiện có; retry request đã hủy cũng có thể đồng bộ order cũ bị kẹt.
    // Chỉ đưa RETURN_REFUND/ISSUE_REPORTED về DELIVERED/PENDING khi không còn return nào khác đang mở.
    // Request tạo sau khi đơn hoàn tất chỉ đổi trạng thái request, không làm lùi tiến độ nhận hàng của order.
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

            // Một return đang mở khác vẫn có quyền giữ order ở RETURN_REFUND; bỏ qua chính request hiện tại vì đã hủy.
            const otherRequests = await requestRepository.find({
                where: { orderId: order.id, ownerId },
                select: { id: true, status: true },
            });
            const hasOtherActiveRequest = otherRequests.some(
                (candidate) =>
                    candidate.id !== request.id &&
                    ACTIVE_ORDER_RETURN_STATUSES.includes(candidate.status),
            );

            // Chỉ phục hồi order đang chờ xử lý issue; bỏ qua khi shop còn một return khác đang chạy.
            if (
                !hasOtherActiveRequest &&
                order.fulfillmentStatus ===
                    OrderFulfillmentStatus.RETURN_REFUND &&
                order.deliveryConfirmationStatus ===
                    OrderDeliveryConfirmationStatus.ISSUE_REPORTED
            ) {
                order.fulfillmentStatus = OrderFulfillmentStatus.DELIVERED;
                order.deliveryConfirmationStatus =
                    OrderDeliveryConfirmationStatus.PENDING;
                order.deliveryConfirmationMethod = null;
                order.deliveryConfirmedAt = null;
                order.completedAt = null;
                await orderRepository.save(order);

                if (linkedIssue) {
                    // Giữ issue cũ để audit; liên kết có thể thiếu ở dữ liệu legacy nhưng order vẫn cần được mở lại.
                    linkedIssue.resolutionNote =
                        'Khách đã hủy yêu cầu hoàn hàng; đơn đang chờ xác nhận nhận hàng hoặc gửi yêu cầu mới.';
                    await manager
                        .getRepository(OrderDeliveryIssue)
                        .save(linkedIssue);
                }
            }

            // Retry đã hủy không phát event trùng; phần phục hồi order phía trên vẫn được chạy idempotent.
            if (wasAlreadyCancelled) return { kind: 'ALREADY_CANCELLED' };

            return {
                kind: 'CANCELLED',
                snapshot: this.toSnapshot(savedRequest, order.orderNumber),
            };
        });
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
