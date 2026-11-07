// Adapter này dựng snapshot thông báo từ khoản hoàn đã commit và dữ liệu order sở hữu khách hàng.
// Chỉ trả ID khách, mã đơn, số tiền và thời điểm; không đọc hay phát tán thông tin tài khoản ngân hàng.

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderDeliveryIssue } from '@/database/delivery/entities/order-delivery-issue.entity';
import type { RefundCompletionRepositoryPort } from '@/modules/order/application/contracts/refund-completion.repository';
import type {
    RefundCompletionSnapshot,
    RefundCompletionSourceType,
} from '@/modules/order/application/types/finance/refund-completion.type';

@Injectable()
export class RefundCompletionRepository implements RefundCompletionRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Chỉ dựng thông báo khi nguồn thực sự đã REFUNDED và có mốc xử lý; dữ liệu người nhận luôn lấy từ Order đã lưu.
    async findCompletedRefund(
        sourceType: RefundCompletionSourceType,
        refundId: string,
    ): Promise<RefundCompletionSnapshot | null> {
        let orderId: string | null = null;
        let refundAmount: string | null = null;
        let occurredAt: Date | null = null;

        // Mỗi nguồn có trạng thái và cột tiền riêng; chỉ chiếu các trường cần cho email để không đưa dữ liệu nhạy cảm vào event.
        switch (sourceType) {
            case 'PAYMENT_ATTEMPT': {
                const attempt = await this.dataSource
                    .getRepository(PaymentAttempt)
                    .findOne({ where: { id: refundId } });
                if (
                    !attempt ||
                    attempt.status !== 'REFUNDED' ||
                    !attempt.refundProcessedAt
                ) {
                    return null;
                }
                orderId = attempt.orderId;
                refundAmount = attempt.amount;
                occurredAt = attempt.refundProcessedAt;
                break;
            }
            case 'ORDER_RETURN': {
                const request = await this.dataSource
                    .getRepository(OrderReturnRequest)
                    .findOne({ where: { id: refundId } });
                if (
                    !request ||
                    request.status !== 'REFUNDED' ||
                    !request.refundProcessedAt
                ) {
                    return null;
                }
                orderId = request.orderId;
                refundAmount = request.refundAmount;
                occurredAt = request.refundProcessedAt;
                break;
            }
            case 'DELIVERY_ISSUE': {
                const issue = await this.dataSource
                    .getRepository(OrderDeliveryIssue)
                    .findOne({ where: { id: refundId } });
                if (
                    !issue ||
                    issue.refundStatus !== 'REFUNDED' ||
                    !issue.refundProcessedAt ||
                    !issue.refundAmount
                ) {
                    return null;
                }
                orderId = issue.orderId;
                refundAmount = issue.refundAmount;
                occurredAt = issue.refundProcessedAt;
                break;
            }
        }

        if (!orderId || !refundAmount || !occurredAt) return null;
        const order = await this.dataSource.getRepository(Order).findOne({
            where: { id: orderId },
            select: { id: true, orderNumber: true, ownerId: true },
        });
        if (!order) return null;

        return {
            refundId,
            sourceType,
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerUserId: order.ownerId,
            refundAmount,
            occurredAt: occurredAt.toISOString(),
        };
    }
}
