// Adapter state transition cho callback shipment hoàn; transaction ngăn webhook và thao tác seller ghi đè lẫn nhau.
import {
    BadRequestException,
    ConflictException,
    Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import type { OrderReturnShipmentRepositoryPort } from '@/modules/order/application/contracts/order-return-shipment.repository';
import type { ReturnShipmentSyncRecord } from '@/modules/order/application/types/returns/return-shipment-sync.type';

@Injectable()
export class OrderReturnShipmentRepository implements OrderReturnShipmentRepositoryPort {
    constructor(private readonly dataSource: DataSource) {}

    // Callback nhận kiện và báo lỗi cùng khóa một bản ghi để event cũ không ghi đè kết quả mới hơn.
    async markShipmentInTransit(
        returnId: string,
    ): Promise<ReturnShipmentSyncRecord> {
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(OrderReturnRequest);
            const request = await repository.findOne({
                where: { id: returnId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            if (request.status === OrderReturnStatus.IN_TRANSIT)
                return this.toSyncRecord(request, false);
            if (
                request.status !== OrderReturnStatus.AWAITING_SHIPMENT &&
                request.status !== OrderReturnStatus.SHIPMENT_FAILED
            )
                throw new ConflictException(
                    'Yêu cầu không ở trạng thái chờ vận chuyển hoàn hàng.',
                );

            request.status = OrderReturnStatus.IN_TRANSIT;
            request.shipmentFailureNote = null;
            const saved = await repository.save(request);
            return this.toSyncRecord(saved, true);
        });
    }

    // Lưu lỗi carrier một lần; webhook lặp trả snapshot hiện tại để không phát sinh transition trùng.
    async markShipmentFailed(
        returnId: string,
        note: string,
    ): Promise<ReturnShipmentSyncRecord> {
        const normalizedNote = note.trim();
        if (normalizedNote.length < 3)
            throw new BadRequestException('Lý do lỗi vận chuyển quá ngắn.');
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(OrderReturnRequest);
            const request = await repository.findOne({
                where: { id: returnId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            if (request.status === OrderReturnStatus.SHIPMENT_FAILED)
                return this.toSyncRecord(request, false);
            if (
                request.status !== OrderReturnStatus.AWAITING_SHIPMENT &&
                request.status !== OrderReturnStatus.IN_TRANSIT
            )
                throw new ConflictException(
                    'Yêu cầu không còn ở trạng thái vận chuyển hoàn hàng.',
                );

            request.status = OrderReturnStatus.SHIPMENT_FAILED;
            request.shipmentFailureNote = normalizedNote;
            const saved = await repository.save(request);
            return this.toSyncRecord(saved, true);
        });
    }

    // Chỉ mở lại vận đơn đã lỗi; callback retry lặp sau commit trả cùng trạng thái mà không ghi thêm lần nữa.
    async markShipmentRetryStarted(
        returnId: string,
    ): Promise<ReturnShipmentSyncRecord> {
        return this.dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(OrderReturnRequest);
            const request = await repository.findOne({
                where: { id: returnId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new BadRequestException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            if (request.status === OrderReturnStatus.AWAITING_SHIPMENT)
                return this.toSyncRecord(request, false);
            if (request.status !== OrderReturnStatus.SHIPMENT_FAILED)
                throw new ConflictException(
                    'Yêu cầu không ở trạng thái có thể tạo lại vận đơn.',
                );

            request.status = OrderReturnStatus.AWAITING_SHIPMENT;
            request.shipmentFailureNote = null;
            const saved = await repository.save(request);
            return this.toSyncRecord(saved, true);
        });
    }

    // Giới hạn adapter response ở các trường event cần dùng, không trả địa chỉ hoặc snapshot sản phẩm.
    private toSyncRecord(
        request: OrderReturnRequest,
        changed: boolean,
    ): ReturnShipmentSyncRecord {
        return {
            id: request.id,
            orderId: request.orderId,
            ownerId: request.ownerId,
            shopId: request.shopId,
            sellerUserId: request.sellerUserId,
            status: request.status,
            refundAmount: request.refundAmount,
            reason: request.reason,
            reviewNote: request.reviewNote,
            shipmentFailureNote: request.shipmentFailureNote,
            changed,
        };
    }
}
