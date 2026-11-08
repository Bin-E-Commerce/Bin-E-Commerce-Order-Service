// Service này áp dụng chính sách sửa của customer và giữ giá trị hoàn đồng nhất với request mới.

import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { OrderEvents } from '@common/kafka/events/order.events';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { RETURN_REQUEST_EDIT_REPOSITORY } from '@/modules/order/application/contracts/return-request-edit.repository';
import type { ReturnRequestEditRepositoryPort } from '@/modules/order/application/contracts/return-request-edit.repository';
import type { UpdateOrderReturnDto } from '@/modules/order/presentation/dto/orders/order-return.dto';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { Inject } from '@nestjs/common';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';
import {
    calculateReturnShippingRefund,
    capReturnRefundAmount,
    getFixedReturnShippingPayer,
    roundReturnVnd,
} from '@/modules/order/application/utils/returns/return-refund-calculation.util';

@Injectable()
export class CustomerReturnRequestEditService {
    private readonly logger = new Logger(CustomerReturnRequestEditService.name);

    constructor(
        @Inject(RETURN_REQUEST_EDIT_REPOSITORY)
        private readonly repository: ReturnRequestEditRepositoryPort,
        private readonly events: OrderEventsService,
    ) {}

    // Chỉ cập nhật request REQUESTED, giữ nguyên item và tính lại snapshot tiền từ dữ liệu order server-side.
    // Evidence rỗng chỉ hợp lệ khi lý do cuối là CHANGE_OF_MIND; mọi lý do lỗi vẫn cần bằng chứng trước khi lưu.
    async update(
        ownerId: string,
        returnId: string,
        dto: UpdateOrderReturnDto,
    ): Promise<{ updated: true }> {
        const snapshot = await this.repository.findForCustomerEdit(
            ownerId,
            returnId,
        );
        if (!snapshot)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        // Row lock kiểm tra lại trạng thái nếu Seller duyệt đồng thời.
        if (snapshot.status !== OrderReturnStatus.REQUESTED)
            throw new ConflictException(
                'Shop đã bắt đầu xử lý yêu cầu; bạn không thể chỉnh sửa lúc này.',
            );

        // Chỉ giữ OTHER trên hồ sơ cũ để tương thích; customer không thể đổi một request hợp lệ sang lý do đã ngừng nhận.
        if (
            dto.reason === OrderReturnReason.OTHER &&
            snapshot.reason !== OrderReturnReason.OTHER
        )
            throw new BadRequestException(
                'Lý do khác không còn được hỗ trợ. Vui lòng chọn một lý do trả hàng phù hợp.',
            );

        this.validateEvidence(dto.evidence, dto.reason);
        const evidence = dto.evidence ?? [];
        // Giữ item scope ban đầu; chỉ sửa nội dung và bằng chứng của request.
        const selectedItems = new Set(snapshot.itemIds);
        const selectedOrderItems = (snapshot.order.items ?? []).filter((item) =>
            selectedItems.has(item.id),
        );
        if (selectedOrderItems.length !== selectedItems.size)
            throw new ConflictException(
                'Danh sách sản phẩm hoàn không còn hợp lệ. Vui lòng tải lại đơn hàng.',
            );

        const itemRefundAmount = roundReturnVnd(
            selectedOrderItems.reduce(
                (sum, item) => sum + toCents(item.lineTotal),
                0n,
            ),
        );
        // Dùng chung chính sách phí tạo mới để giữ snapshot hoàn nhất quán.
        const shippingRefundAmount = calculateReturnShippingRefund(
            snapshot.order,
            itemRefundAmount,
            dto.reason,
            snapshot.shopId,
        );
        const returnShippingPayer = getFixedReturnShippingPayer(dto.reason);
        const estimatedReturnShippingCost = toCents(
            snapshot.returnShippingEstimatedCost,
        );
        // Từ chối lý do khách chịu phí nếu quote vượt giá trị món hàng.
        if (
            returnShippingPayer === 'CUSTOMER' &&
            estimatedReturnShippingCost > itemRefundAmount
        )
            throw new ConflictException(
                'Phí hoàn hàng dự kiến cao hơn giá trị sản phẩm; không thể chọn lý do này.',
            );

        const estimatedCustomerDeduction =
            returnShippingPayer === 'CUSTOMER'
                ? estimatedReturnShippingCost
                : 0n;
        const estimatedRefundAmount = capReturnRefundAmount(
            itemRefundAmount +
                shippingRefundAmount -
                estimatedCustomerDeduction,
            snapshot.order.totalAmount,
        );
        const result = await this.repository.updateRequested({
            ownerId,
            returnId,
            expectedUpdatedAt: dto.expectedUpdatedAt,
            reason: dto.reason,
            description: dto.description?.trim() || null,
            evidence,
            refundItemAmount: fromCents(itemRefundAmount),
            refundShippingAmount: fromCents(shippingRefundAmount),
            estimatedRefundAmount: fromCents(estimatedRefundAmount),
            returnShippingPayer,
        });

        if (result.kind === 'NOT_FOUND')
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (result.kind === 'NOT_EDITABLE')
            throw new ConflictException(
                'Shop đã bắt đầu xử lý yêu cầu; bạn không thể chỉnh sửa lúc này.',
            );
        if (result.kind === 'STALE')
            throw new ConflictException(
                'Yêu cầu vừa được cập nhật. Vui lòng tải lại rồi thử lại.',
            );

        try {
            await this.events.publishReturnChanged({
                eventName: OrderEvents.RETURN_UPDATED,
                returnId: result.snapshot.id,
                orderId: result.snapshot.orderId,
                orderNumber: result.snapshot.orderNumber,
                shopId: result.snapshot.shopId,
                customerUserId: result.snapshot.ownerId,
                sellerUserId: result.snapshot.sellerUserId,
                status: result.snapshot.status,
                refundAmount: result.snapshot.refundAmount,
                reason: result.snapshot.reason,
                note: result.snapshot.description,
                revision: result.snapshot.updatedAt,
            });
        } catch (error) {
            // Lưu request là kết quả chính; seller vẫn thấy nội dung mới trong queue dù Kafka tạm thời lỗi.
            this.logger.warn(
                `Không gửi được thông báo chỉnh sửa yêu cầu hoàn ${returnId}: ${error instanceof Error ? error.message : 'unknown'}`,
            );
        }
        return { updated: true };
    }

    // Áp dụng cùng yêu cầu chứng cứ như khi tạo mới để endpoint sửa không thể lách policy.
    // CHANGE_OF_MIND cho phép danh sách rỗng; các lý do lỗi phải giữ ít nhất một tệp và mọi lý do vẫn bị giới hạn quota.
    private validateEvidence(
        evidence: UpdateOrderReturnDto['evidence'],
        reason: OrderReturnReason,
    ): void {
        const attachments = evidence ?? [];
        const images = attachments.filter((item) => item.type === 'image');
        const videos = attachments.filter((item) => item.type === 'video');
        if (
            reason !== OrderReturnReason.CHANGE_OF_MIND &&
            attachments.length === 0
        )
            throw new BadRequestException(
                'Yêu cầu hoàn hàng cần ít nhất một ảnh hoặc video bằng chứng.',
            );
        if (images.length > 5 || videos.length > 1)
            throw new BadRequestException(
                'Tối đa 5 ảnh và 1 video cho bằng chứng hoàn hàng.',
            );
    }
}
