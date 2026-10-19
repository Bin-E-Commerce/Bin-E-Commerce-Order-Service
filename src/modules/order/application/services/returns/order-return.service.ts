// File này điều phối toàn bộ vòng đời yêu cầu hoàn hàng trong Order Service.
// Service sở hữu ownership, state transition và số tiền hoàn; vận đơn/repository media là boundary của service khác.

import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import {
    ACTIVE_ORDER_RETURN_STATUSES,
    OrderReturnStatus,
} from '@/database/returns/enums/order-return-status.enum';
import { Order } from '@/database/order/entities/order.entity';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderDeliveryConfirmationStatus } from '@/database/delivery/enums/order-delivery-confirmation-status.enum';
import { OrderRepository } from '@/modules/order/infrastructure/repositories/order.repository';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/order-money.util';
import {
    ShippingClient,
    type GhnAddressSelectionInput,
} from '@/modules/order/application/clients/shipping.client';
import type {
    CreateOrderReturnDto,
    InspectOrderReturnDto,
    ReviewOrderReturnDto,
} from '@/modules/order/presentation/dto/order-return.dto';
import type { SellerOrderUserContext } from '@/modules/order/application/types/seller-order-user-context.type';
import { PaymentService } from '@/modules/order/application/services/payment/payment.service';
import { Inject } from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';

const EVIDENCE_REQUIRED_REASONS = new Set<OrderReturnReason>([
    OrderReturnReason.DAMAGED,
    OrderReturnReason.WRONG_ITEM,
    OrderReturnReason.MISSING_ITEM,
    OrderReturnReason.NOT_AS_DESCRIBED,
]);

@Injectable()
export class OrderReturnService {
    constructor(
        @InjectRepository(OrderReturnRequest)
        private readonly repository: Repository<OrderReturnRequest>,
        private readonly orders: OrderRepository,
        private readonly sellerShopClient: SellerShopClient,
        private readonly events: OrderEventsService,
        @Optional() private readonly shippingClient?: ShippingClient,
        @Optional() private readonly dataSource?: DataSource,
        @Optional() private readonly paymentService?: PaymentService,
        @Optional()
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly sellerWalletRepository?: SellerWalletRepositoryPort,
    ) {}

    // Tạo một request cho đúng một shop; UI nhiều shop phải gọi lại endpoint theo từng nhóm item.
    // Kiểm tra application layer giúp phản hồi nhanh khi quy trình hoàn đang mở.
    // Unique partial index ở database xử lý trường hợp hai request chạy đồng thời sau cùng một lần kiểm tra.
    async create(ownerId: string, orderId: string, dto: CreateOrderReturnDto) {
        const order = await this.orders.findOwnedById(ownerId, orderId);
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng.');
        if (
            ![
                OrderFulfillmentStatus.DELIVERED,
                OrderFulfillmentStatus.COMPLETED,
            ].includes(order.fulfillmentStatus)
        )
            throw new ConflictException(
                'Đơn hàng chưa đủ điều kiện hoàn hàng.',
            );
        if (order.returnWindowUntil && order.returnWindowUntil < new Date())
            throw new ConflictException('Đã hết thời hạn hoàn hàng.');
        this.validateEvidence(dto);
        const itemMap = new Map(
            (order.items ?? []).map((item) => [item.id, item]),
        );
        const itemIds = [...new Set(dto.itemIds)];
        if (itemIds.some((itemId) => !itemMap.has(itemId)))
            throw new BadRequestException(
                'Sản phẩm hoàn không thuộc đơn hàng.',
            );
        const shopIds = new Set(
            itemIds
                .map((itemId) => itemMap.get(itemId)?.sellerShopId)
                .filter(Boolean),
        );
        if (shopIds.size !== 1)
            throw new BadRequestException(
                'Mỗi yêu cầu chỉ được thuộc một shop.',
            );
        const shopId = [...shopIds][0] as string;
        const existing = await this.findActiveRequest(orderId, ownerId, shopId);
        if (existing) return existing;
        const itemRefundAmount = this.roundVnd(
            itemIds.reduce(
                (sum, itemId) => sum + toCents(itemMap.get(itemId)!.lineTotal),
                0n,
            ),
        );
        const shippingRefundAmount = this.calculateShippingRefund(
            order,
            itemIds,
            itemRefundAmount,
            dto.reason,
            shopId,
        );
        // Chốt quote chiều customer → shop ngay lúc tạo request để customer thấy đúng số tiền dự kiến,
        // Customer và seller dùng cùng một snapshot, không tự tính lại số tiền từ subtotal ở từng màn hình.
        const returnShippingEstimatedCost = await this.quoteReturnShippingCost(
            order,
            itemIds,
            itemRefundAmount,
            shopId,
        );
        const returnShippingPayer = this.getFixedShippingPayer(dto.reason);
        if (
            returnShippingPayer === 'CUSTOMER' &&
            returnShippingEstimatedCost > itemRefundAmount
        ) {
            throw new ConflictException(
                'Phí hoàn hàng dự kiến cao hơn giá trị sản phẩm; chưa thể gửi yêu cầu hoàn.',
            );
        }
        const estimatedCustomerDeduction =
            returnShippingPayer === 'CUSTOMER'
                ? returnShippingEstimatedCost
                : 0n;
        const estimatedRefundAmount = this.capRefundAmount(
            itemRefundAmount +
                shippingRefundAmount -
                estimatedCustomerDeduction,
            order.totalAmount,
        );
        const request = this.repository.create({
            orderId,
            ownerId,
            shopId,
            sellerUserId: itemMap.get(itemIds[0]!)?.sellerOwnerId ?? null,
            itemIds,
            status: OrderReturnStatus.REQUESTED,
            reason: dto.reason,
            description: dto.description?.trim() || null,
            reviewNote: null,
            evidence: dto.evidence ?? [],
            refundAmount: fromCents(estimatedRefundAmount),
            estimatedRefundAmount: fromCents(estimatedRefundAmount),
            refundItemAmount: fromCents(itemRefundAmount),
            refundShippingAmount: fromCents(shippingRefundAmount),
            returnShippingFee: fromCents(0n),
            returnShippingEstimatedCost: fromCents(returnShippingEstimatedCost),
            returnShippingCost: fromCents(0n),
            returnShippingPayer,
            returnShippingFinalizedAt: null,
            customerReturnShippingReceivableAmount: fromCents(0n),
            inspectionPassed: null,
            inspectionNote: null,
            inspectedAt: null,
            reviewedAt: null,
        });
        let saved: OrderReturnRequest;
        try {
            saved = await this.repository.save(request);
        } catch (error) {
            // Nếu request khác vừa insert cùng order/shop, trả về bản ghi đã tồn tại thay vì tạo workflow thứ hai.
            if (!this.isActiveReturnUniqueViolation(error)) throw error;
            const concurrentRequest = await this.findActiveRequest(
                orderId,
                ownerId,
                shopId,
            );
            if (concurrentRequest) return concurrentRequest;
            throw new ConflictException(
                'Đơn hàng đã có yêu cầu hoàn hàng đang được xử lý.',
            );
        }
        // Gửi mô tả của Customer trong event đầu tiên để notification/email cho Seller có đủ ngữ cảnh xử lý.
        await this.publish(
            saved,
            order.orderNumber,
            ownerId,
            'return.requested',
            request.description,
        );
        return saved;
    }

    // Customer đọc các request trong order của chính mình; request cũ chưa có phí sẽ được bổ sung quote một lần.
    async list(ownerId: string, orderId: string) {
        const order = await this.orders.findOwnedById(ownerId, orderId);
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng.');
        const requests = await this.repository.find({
            where: { orderId, ownerId },
            order: { createdAt: 'DESC' },
        });
        return Promise.all(
            requests.map((request) =>
                this.ensureReturnShippingQuote(request, order),
            ),
        );
    }

    // Customer xem detail của một request; dữ liệu legacy chưa có phí được chuẩn hóa trước khi trả về.
    async getForCustomer(ownerId: string, returnId: string) {
        const request = await this.repository.findOne({
            where: { id: returnId, ownerId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        const order = await this.orders.findOwnedById(ownerId, request.orderId);
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng gốc.');
        return this.ensureReturnShippingQuote(request, order);
    }

    // Customer chỉ được hủy khi seller chưa duyệt và thao tác này idempotent.
    async cancel(ownerId: string, returnId: string) {
        const request = await this.getForCustomer(ownerId, returnId);
        if (request.status === OrderReturnStatus.CUSTOMER_CANCELLED)
            return request;
        if (request.status !== OrderReturnStatus.REQUESTED)
            throw new ConflictException('Yêu cầu đã được shop xử lý.');
        request.status = OrderReturnStatus.CUSTOMER_CANCELLED;
        const saved = await this.repository.save(request);
        const order = await this.orders.findOwnedById(ownerId, request.orderId);
        await this.publish(
            saved,
            order?.orderNumber ?? '',
            ownerId,
            'return.cancelled',
        );
        return saved;
    }

    // Seller queue chỉ trả request thuộc shop được resolve từ session, đồng thời bổ sung quote cho request legacy.
    async listForSeller(
        currentUser: SellerOrderUserContext,
        status?: OrderReturnStatus,
    ) {
        const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
        const requests = await this.repository.find({
            where: { shopId, ...(status ? { status } : {}) },
            order: { createdAt: 'ASC' },
        });
        return Promise.all(
            requests.map(async (request) => {
                const order = await this.orders.findOwnedById(
                    request.ownerId,
                    request.orderId,
                );
                return order
                    ? this.ensureReturnShippingQuote(request, order)
                    : request;
            }),
        );
    }

    // Seller approve hoặc reject request đang chờ; OTHER bắt buộc phân loại bên chịu phí trước khi mở tạo vận đơn.
    // Với các request được tạo từ form hoàn hàng độc lập, approve cũng phải đưa order ra khỏi tab Hoàn thành/Chờ xác nhận.
    async review(
        currentUser: SellerOrderUserContext,
        returnId: string,
        dto: ReviewOrderReturnDto,
        status: OrderReturnStatus,
    ) {
        const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
        const request = await this.repository.findOne({
            where: { id: returnId, shopId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (request.status !== OrderReturnStatus.REQUESTED)
            throw new ConflictException('Yêu cầu đã được xử lý.');
        const reviewNote = dto.note?.trim() || '';
        if (status === OrderReturnStatus.REJECTED && reviewNote.length < 10) {
            throw new BadRequestException(
                'Seller phải nhập lý do từ chối ít nhất 10 ký tự.',
            );
        }
        if (status === OrderReturnStatus.APPROVED) {
            const fixedPayer = this.getFixedShippingPayer(
                request.reason as OrderReturnReason,
            );
            if (
                fixedPayer &&
                dto.returnShippingPayer &&
                dto.returnShippingPayer !== fixedPayer
            ) {
                throw new BadRequestException(
                    'Bên chịu phí hoàn không khớp với lý do đã chọn.',
                );
            }
            request.returnShippingPayer =
                fixedPayer ?? dto.returnShippingPayer ?? null;
            if (!request.returnShippingPayer) {
                throw new BadRequestException(
                    'Seller cần chọn bên chịu phí hoàn cho lý do khác.',
                );
            }
            const quotedCost = toCents(request.returnShippingEstimatedCost);
            const itemAmount = toCents(request.refundItemAmount);
            if (
                request.returnShippingPayer === 'CUSTOMER' &&
                quotedCost > itemAmount
            ) {
                throw new ConflictException(
                    'Phí hoàn hàng dự kiến cao hơn giá trị sản phẩm nên không thể duyệt theo phương án khách trả phí.',
                );
            }
            const customerDeduction =
                request.returnShippingPayer === 'CUSTOMER' ? quotedCost : 0n;
            // Duyệt chỉ chốt bên chịu phí và refund dự kiến; chưa ghi phí thực tế trước khi GHN nhận kiện.
            request.returnShippingFee = fromCents(0n);
            request.estimatedRefundAmount = fromCents(
                this.capRefundAmount(
                    itemAmount +
                        toCents(request.refundShippingAmount) -
                        customerDeduction,
                ),
            );
            request.refundAmount = request.estimatedRefundAmount;
        }
        request.status =
            status === OrderReturnStatus.APPROVED
                ? OrderReturnStatus.AWAITING_SHIPMENT
                : OrderReturnStatus.REJECTED;
        request.reviewNote = reviewNote || null;
        request.reviewedAt = new Date();
        request.sellerUserId = currentUser.userId;
        const saved = await this.repository.save(request);
        const order = await this.orders.findOwnedById(
            request.ownerId,
            request.orderId,
        );
        if (status === OrderReturnStatus.APPROVED && order) {
            await this.moveOrderToReturnRefund(order);
        }
        await this.publish(
            saved,
            order?.orderNumber ?? '',
            request.ownerId,
            status === OrderReturnStatus.APPROVED
                ? 'return.approved'
                : 'return.rejected',
        );
        return saved;
    }

    // Shipping Service gọi callback nội bộ khi kiện hoàn đã về shop để mở bước inspection.
    // Shipping Service gọi callback idempotent sau khi reverse shipment đã được tạo để Seller queue ẩn nút tạo vận đơn.
    async markInTransit(returnId: string) {
        const request = await this.repository.findOne({
            where: { id: returnId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (request.status === OrderReturnStatus.IN_TRANSIT) return request;
        if (request.status !== OrderReturnStatus.AWAITING_SHIPMENT) {
            throw new ConflictException(
                'Yêu cầu không ở trạng thái chờ tạo vận đơn hoàn.',
            );
        }

        request.status = OrderReturnStatus.IN_TRANSIT;
        const saved = await this.repository.save(request);
        const order = await this.orders.findOwnedById(
            request.ownerId,
            request.orderId,
        );
        await this.publish(
            saved,
            order?.orderNumber ?? '',
            request.ownerId,
            'return.in_transit',
        );
        return saved;
    }

    async markReceived(returnId: string) {
        const request = await this.repository.findOne({
            where: { id: returnId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (request.status === OrderReturnStatus.RECEIVED) return request;
        if (
            ![
                OrderReturnStatus.AWAITING_SHIPMENT,
                OrderReturnStatus.IN_TRANSIT,
            ].includes(request.status)
        )
            throw new ConflictException('Trạng thái không thể nhận hàng hoàn.');
        request.status = OrderReturnStatus.RECEIVED;
        const saved = await this.repository.save(request);
        const order = await this.orders.findOwnedById(
            request.ownerId,
            request.orderId,
        );
        await this.publish(
            saved,
            order?.orderNumber ?? '',
            request.ownerId,
            'return.received',
        );
        return saved;
    }

    // Shipping Service chỉ nhận snapshot tối thiểu của request đã duyệt để tạo vận đơn chiều ngược.
    async getShippingContext(returnId: string) {
        const request = await this.repository.findOne({
            where: { id: returnId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (
            ![
                OrderReturnStatus.AWAITING_SHIPMENT,
                OrderReturnStatus.IN_TRANSIT,
            ].includes(request.status)
        )
            throw new ConflictException(
                'Yêu cầu chưa sẵn sàng tạo vận đơn hoàn.',
            );
        const order = await this.orders.findOwnedById(
            request.ownerId,
            request.orderId,
        );
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng gốc.');
        const selected = new Set(request.itemIds);
        return {
            returnId: request.id,
            orderId: request.orderId,
            orderNumber: order.orderNumber,
            ownerId: request.ownerId,
            shopId: request.shopId,
            reason: request.reason,
            returnShippingPayer: request.returnShippingPayer,
            returnShippingEstimatedCost: request.returnShippingEstimatedCost,
            refundItemAmount: request.refundItemAmount,
            shippingAddress: order.shippingAddress,
            items: (order.items ?? [])
                .filter((item) => selected.has(item.id))
                .map((item) => ({
                    productId: item.productId,
                    sku: item.sku,
                    productName: item.productName,
                    imageUrl: item.imageUrl,
                    unitPrice: item.unitPrice,
                    quantity: item.quantity,
                    lineTotal: item.lineTotal,
                    packageWeightGrams: item.packageWeightGrams ?? 1,
                    packageLengthCm: Number(item.packageLengthCm ?? 1),
                    packageWidthCm: Number(item.packageWidthCm ?? 1),
                    packageHeightCm: Number(item.packageHeightCm ?? 1),
                })),
        };
    }

    // Shipping Service chỉ gọi sau mốc GHN nhận kiện; tại đây mới chốt phí thật và cập nhật refund cuối cùng.
    async updateReturnShippingCost(returnId: string, amount: string) {
        const request = await this.repository.findOne({
            where: { id: returnId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        const actualCost = this.roundVnd(toCents(amount));
        // Callback RETURNED có thể lặp sau khi request đã RECEIVED; nếu phí đã chốt thì chỉ xác nhận cùng snapshot, không mở lại state machine.
        if (request.returnShippingFinalizedAt) {
            if (toCents(request.returnShippingCost) !== actualCost) {
                throw new ConflictException(
                    'Phí vận chuyển hoàn đã chốt và không thể thay đổi.',
                );
            }
            return request;
        }
        if (
            ![
                OrderReturnStatus.AWAITING_SHIPMENT,
                OrderReturnStatus.IN_TRANSIT,
            ].includes(request.status)
        ) {
            throw new ConflictException(
                'Yêu cầu chưa ở trạng thái tạo vận đơn hoàn.',
            );
        }
        if (!request.returnShippingPayer) {
            throw new ConflictException(
                'Chưa phân loại bên chịu phí hoàn hàng.',
            );
        }

        const itemAmount = this.roundVnd(toCents(request.refundItemAmount));
        const customerDeduction =
            request.returnShippingPayer === 'CUSTOMER' ? actualCost : 0n;
        if (customerDeduction > itemAmount) {
            throw new ConflictException(
                'Phí hoàn thực tế cao hơn giá trị sản phẩm; cần hủy vận đơn trước khi nhận kiện.',
            );
        }
        const order = await this.orders.findOwnedById(
            request.ownerId,
            request.orderId,
        );
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng gốc.');
        // Ghi phí courier trước khi chốt return; source key giúp retry sau timeout không trừ ví seller lần hai.
        if (actualCost > 0n) {
            await this.sellerWalletRepository?.recordReturnShippingFee(
                returnId,
                fromCents(actualCost),
            );
        }

        const outboundShippingRefund = this.roundVnd(
            toCents(request.refundShippingAmount),
        );
        request.returnShippingCost = fromCents(actualCost);
        request.returnShippingFee = fromCents(customerDeduction);
        request.returnShippingFinalizedAt = new Date();
        request.customerReturnShippingReceivableAmount = fromCents(0n);
        const finalRefund =
            itemAmount + outboundShippingRefund - customerDeduction;
        request.refundAmount = fromCents(
            this.capRefundAmount(finalRefund, order.totalAmount),
        );
        return this.repository.save(request);
    }

    // Từ chối yêu cầu khi phí carrier sau lúc tạo nhãn vượt giá trị món khách hoàn.
    // Shipping Service phải hủy vận đơn trước khi gọi; transaction khóa request/order để callback retry không tạo phí hoặc trạng thái trùng.
    // Sau khi từ chối, order quay về DELIVERED/COMPLETED thay vì bị kẹt trong nhóm Trả hàng/Hoàn tiền.
    async rejectForReturnShippingCostLimit(
        returnId: string,
        carrierFee: string,
    ): Promise<OrderReturnRequest> {
        if (!this.dataSource) {
            throw new Error(
                'Order DataSource is required to reject over-limit return shipments.',
            );
        }

        const fee = this.roundVnd(toCents(carrierFee));
        const result = await this.dataSource.transaction(async (manager) => {
            const requestRepository = manager.getRepository(OrderReturnRequest);
            const request = await requestRepository.findOne({
                where: { id: returnId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new NotFoundException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );

            const rejectionPrefix = 'Phí hoàn GHN vượt giá trị hàng hoàn.';
            if (
                request.status === OrderReturnStatus.REJECTED &&
                request.reviewNote?.startsWith(rejectionPrefix)
            ) {
                const orderRepository = manager.getRepository(Order);
                const order = await orderRepository.findOne({
                    where: { id: request.orderId },
                    lock: { mode: 'pessimistic_write' },
                });
                if (
                    order?.fulfillmentStatus ===
                    OrderFulfillmentStatus.RETURN_REFUND
                ) {
                    const wasConfirmed = [
                        OrderDeliveryConfirmationStatus.CONFIRMED,
                        OrderDeliveryConfirmationStatus.AUTO_CONFIRMED,
                    ].includes(order.deliveryConfirmationStatus);
                    order.fulfillmentStatus = wasConfirmed
                        ? OrderFulfillmentStatus.COMPLETED
                        : OrderFulfillmentStatus.DELIVERED;
                    await orderRepository.save(order);
                }
                return { request, order, shouldPublish: false };
            }
            if (request.status !== OrderReturnStatus.AWAITING_SHIPMENT)
                throw new ConflictException(
                    'Yêu cầu không còn chờ tạo vận đơn hoàn.',
                );
            if (request.returnShippingPayer !== 'CUSTOMER')
                throw new ConflictException(
                    'Ngưỡng phí hoàn chỉ áp dụng khi khách chịu phí.',
                );

            const itemAmount = this.roundVnd(toCents(request.refundItemAmount));
            if (fee <= itemAmount)
                throw new BadRequestException(
                    'Phí GHN chưa vượt giá trị sản phẩm được hoàn.',
                );

            // Vận đơn bị hủy trước khi GHN nhận kiện nên không ghi phí thực tế, không trừ refund và không tạo khoản phải thu.
            request.status = OrderReturnStatus.REJECTED;
            request.returnShippingCost = fromCents(0n);
            request.returnShippingFee = fromCents(0n);
            request.returnShippingFinalizedAt = null;
            request.customerReturnShippingReceivableAmount = fromCents(0n);
            request.reviewNote = `${rejectionPrefix} GHN báo ${fromCents(fee)} đ, cao hơn giá trị sản phẩm ${fromCents(itemAmount)} đ; vận đơn đã được hủy trước khi nhận kiện nên không ghi nhận phí.`;
            const saved = await requestRepository.save(request);
            const order = await manager.getRepository(Order).findOne({
                where: { id: request.orderId },
                lock: { mode: 'pessimistic_write' },
            });
            if (
                order?.fulfillmentStatus ===
                OrderFulfillmentStatus.RETURN_REFUND
            ) {
                const wasConfirmed = [
                    OrderDeliveryConfirmationStatus.CONFIRMED,
                    OrderDeliveryConfirmationStatus.AUTO_CONFIRMED,
                ].includes(order.deliveryConfirmationStatus);
                order.fulfillmentStatus = wasConfirmed
                    ? OrderFulfillmentStatus.COMPLETED
                    : OrderFulfillmentStatus.DELIVERED;
                await manager.getRepository(Order).save(order);
            }
            return { request: saved, order, shouldPublish: true };
        });

        // Chỉ lần đầu chuyển trạng thái mới phát event; callback retry không gửi thông báo trùng.
        if (result.shouldPublish)
            await this.publish(
                result.request,
                result.order?.orderNumber ?? '',
                result.request.ownerId,
                'return.rejected',
            );
        return result.request;
    }

    // Seller ghi nhận pass/fail sau khi kiểm tra; phase hiện tại chỉ dừng ở chờ hoàn tiền hoặc chờ gửi trả sản phẩm.
    async inspect(
        currentUser: SellerOrderUserContext,
        returnId: string,
        dto: InspectOrderReturnDto,
    ) {
        if (!this.dataSource) {
            throw new Error(
                'Order DataSource is required for return inspection.',
            );
        }
        const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
        const result = await this.dataSource.transaction<{
            saved: OrderReturnRequest;
            orderNumber: string;
            ownerId: string;
            eventType: ReturnEventName | null;
        }>(async (manager) => {
            const requestRepository = manager.getRepository(OrderReturnRequest);
            const request = await requestRepository.findOne({
                where: { id: returnId, shopId },
                lock: { mode: 'pessimistic_write' },
            });
            if (!request)
                throw new NotFoundException(
                    'Không tìm thấy yêu cầu hoàn hàng.',
                );
            // Nếu lưu trạng thái xong nhưng ghi khoản phải thu lỗi, cho phép retry cùng kết quả mà không đổi state lần hai.
            if (
                request.status === OrderReturnStatus.INSPECTION_FAILED &&
                !dto.passed
            )
                return {
                    saved: request,
                    orderNumber: '',
                    ownerId: request.ownerId,
                    eventType: null,
                };
            if (request.status !== OrderReturnStatus.RECEIVED)
                throw new ConflictException(
                    'Hàng hoàn chưa được ghi nhận tại shop.',
                );
            request.inspectionPassed = dto.passed;
            request.inspectionNote = dto.note?.trim() || null;
            request.inspectedAt = new Date();
            request.status = dto.passed
                ? OrderReturnStatus.REFUND_PENDING
                : OrderReturnStatus.INSPECTION_FAILED;
            // Kiểm hàng không đạt thì không còn refund để khấu trừ; lưu khoản phải thu riêng, chưa coi là tiền đã thu.
            request.customerReturnShippingReceivableAmount =
                !dto.passed &&
                request.returnShippingPayer === 'CUSTOMER' &&
                request.returnShippingFinalizedAt
                    ? request.returnShippingCost
                    : fromCents(0n);
            const saved = await requestRepository.save(request);
            const order = await manager.getRepository(Order).findOne({
                where: { id: request.orderId },
                relations: { items: true },
            });
            if (dto.passed) {
                await this.events.publishPurchaseReturned?.(
                    request.orderId,
                    request.id,
                    request.itemIds,
                    manager,
                );
            }
            // Giữ event name trong union hợp lệ để retry failed-inspection có thể bỏ qua phát event lần hai.
            const eventType: ReturnEventName = dto.passed
                ? 'return.inspection.passed'
                : 'return.inspection.failed';
            return {
                saved,
                orderNumber: order?.orderNumber ?? '',
                ownerId: request.ownerId,
                eventType,
            };
        });
        if (result.eventType)
            await this.publish(
                result.saved,
                result.orderNumber,
                result.ownerId,
                result.eventType,
            );
        if (
            !dto.passed &&
            result.saved.returnShippingPayer === 'CUSTOMER' &&
            result.saved.returnShippingFinalizedAt &&
            toCents(result.saved.returnShippingCost) > 0n
        ) {
            // Phí đã phát sinh nhưng không còn khoản hoàn để khấu trừ; ghi receivable idempotent, không cộng vào cash balance.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record return-shipping receivables.',
                );
            await this.sellerWalletRepository.recordCustomerReturnShippingReceivable(
                result.saved.id,
                result.saved.returnShippingCost,
            );
        }
        if (
            dto.passed &&
            result.saved.status === OrderReturnStatus.REFUND_PENDING
        ) {
            // VNPay refund bắt đầu sau commit; lỗi provider giữ yêu cầu ở REFUND_PENDING để có thể đối soát lại.
            await this.paymentService
                ?.refundVnpayReturn(result.saved.id, currentUser.userId)
                .catch(() => undefined);
        }
        return result.saved;
    }

    private validateEvidence(dto: CreateOrderReturnDto): void {
        const evidence = dto.evidence ?? [];
        const images = evidence.filter((item) => item.type === 'image');
        const videos = evidence.filter((item) => item.type === 'video');
        if (images.length > 5 || videos.length > 1)
            throw new BadRequestException(
                'Tối đa 5 ảnh và 1 video cho bằng chứng hoàn hàng.',
            );
        if (EVIDENCE_REQUIRED_REASONS.has(dto.reason) && images.length === 0)
            throw new BadRequestException(
                'Lý do này cần ít nhất một ảnh bằng chứng.',
            );
    }

    // Tìm request đang mở theo đúng phạm vi order/shop để mọi trạng thái xử lý đều được khóa nghiệp vụ.
    private findActiveRequest(
        orderId: string,
        ownerId: string,
        shopId: string,
    ): Promise<OrderReturnRequest | null> {
        return this.repository.findOne({
            where: {
                orderId,
                ownerId,
                shopId,
                status: In([...ACTIVE_ORDER_RETURN_STATUSES]),
            },
        });
    }

    // Chỉ nhận diện đúng unique index chống duplicate; các lỗi database khác phải được giữ nguyên để không che lỗi hệ thống.
    private isActiveReturnUniqueViolation(error: unknown): boolean {
        if (!(error instanceof QueryFailedError)) return false;
        const driverError = error.driverError as {
            code?: string;
            constraint?: string;
        };
        return (
            driverError.code === '23505' &&
            driverError.constraint === 'uq_order_return_active_order_shop'
        );
    }

    // Đưa order vào nhóm Trả hàng/Hoàn tiền khi Seller chấp thuận return.
    // Return request vẫn giữ state AWAITING_SHIPMENT/IN_TRANSIT riêng; order không bị đánh dấu CANCELLED vì đã giao hàng.
    private async moveOrderToReturnRefund(order: Order): Promise<void> {
        if (order.fulfillmentStatus === OrderFulfillmentStatus.RETURN_REFUND) {
            return;
        }

        order.fulfillmentStatus = OrderFulfillmentStatus.RETURN_REFUND;
        await this.orders.getEntityRepository().save(order);
    }

    // Gọi quote GHN chiều ngược bằng snapshot order; phí quote được làm tròn VND và lưu vào request.
    // Không fallback về 0 vì 0 là dữ liệu thiếu, sẽ làm sai refund của lý do khách chịu phí.
    private async quoteReturnShippingCost(
        order: {
            shippingAddress: Record<string, unknown>;
            items?: Array<{
                id: string;
                lineTotal: string;
                quantity: number;
                packageWeightGrams: number | null;
                packageLengthCm: string | null;
                packageWidthCm: string | null;
                packageHeightCm: string | null;
            }>;
        },
        itemIds: string[],
        itemAmount: bigint,
        shopId: string,
    ): Promise<bigint> {
        if (!this.shippingClient)
            throw new BadRequestException(
                'Shipping Service chưa sẵn sàng báo phí hoàn hàng.',
            );
        const selected = new Set(itemIds);
        const items = (order.items ?? []).filter((item) =>
            selected.has(item.id),
        );
        if (!items.length)
            throw new BadRequestException(
                'Không có sản phẩm để báo phí hoàn hàng.',
            );
        const shippingAddress = order.shippingAddress;
        const quote = await this.shippingClient.calculateQuote({
            shopId,
            shipmentKind: 'RETURN',
            to: {
                contactName: String(
                    shippingAddress.fullName ??
                        shippingAddress.contactName ??
                        'Người nhận',
                ),
                phone: String(shippingAddress.phone ?? ''),
                addressLine: String(
                    shippingAddress.street ?? shippingAddress.addressLine ?? '',
                ),
                province: String(shippingAddress.province ?? ''),
                district: String(shippingAddress.district ?? ''),
                ward: String(shippingAddress.ward ?? ''),
                ...(shippingAddress.ghnAddress
                    ? {
                          ghnAddress:
                              shippingAddress.ghnAddress as GhnAddressSelectionInput,
                      }
                    : {}),
            },
            weightGrams: Math.max(
                1,
                Math.round(
                    items.reduce(
                        (sum, item) =>
                            sum +
                            (item.packageWeightGrams ?? 1) * item.quantity,
                        0,
                    ),
                ),
            ),
            lengthCm: Math.max(
                1,
                Math.round(
                    Math.max(
                        ...items.map((item) =>
                            Number(item.packageLengthCm ?? 1),
                        ),
                    ),
                ),
            ),
            widthCm: Math.max(
                1,
                Math.round(
                    Math.max(
                        ...items.map((item) =>
                            Number(item.packageWidthCm ?? 1),
                        ),
                    ),
                ),
            ),
            heightCm: Math.max(
                1,
                Math.round(
                    items.reduce(
                        (sum, item) =>
                            sum +
                            Number(item.packageHeightCm ?? 1) * item.quantity,
                        0,
                    ),
                ),
            ),
            value: Number(itemAmount) / 100,
            codAmount: 0,
        });
        const quotedCost = this.roundVnd(toCents(quote.fee));
        if (quotedCost <= 0n)
            throw new BadRequestException(
                'GHN không trả về phí hoàn hàng hợp lệ.',
            );
        return quotedCost;
    }

    // Bổ sung quote cho request được tạo trước khi có cơ chế báo phí chiều ngược.
    // Chỉ request đang chờ xử lý mới được cập nhật; request đã hoàn tất giữ nguyên snapshot tài chính lịch sử.
    private async ensureReturnShippingQuote(
        request: OrderReturnRequest,
        order: {
            shippingAddress: Record<string, unknown>;
            totalAmount?: string;
            items?: Array<{
                id: string;
                lineTotal: string;
                quantity: number;
                packageWeightGrams: number | null;
                packageLengthCm: string | null;
                packageWidthCm: string | null;
                packageHeightCm: string | null;
            }>;
        },
    ): Promise<OrderReturnRequest> {
        const quoteStatuses = new Set<OrderReturnStatus>([
            OrderReturnStatus.REQUESTED,
            OrderReturnStatus.AWAITING_SHIPMENT,
        ]);
        if (
            toCents(request.returnShippingEstimatedCost) > 0n ||
            !quoteStatuses.has(request.status)
        )
            return request;
        const selectedItems = (order.items ?? []).filter((item) =>
            request.itemIds.includes(item.id),
        );
        const itemAmount = this.roundVnd(
            selectedItems.reduce(
                (sum, item) => sum + toCents(item.lineTotal),
                0n,
            ),
        );
        const quotedCost = await this.quoteReturnShippingCost(
            order,
            request.itemIds,
            itemAmount,
            request.shopId,
        );
        const payer =
            request.returnShippingPayer ??
            this.getFixedShippingPayer(request.reason as OrderReturnReason);
        const estimatedCustomerDeduction =
            payer === 'CUSTOMER' ? quotedCost : 0n;
        request.returnShippingPayer = payer;
        request.returnShippingEstimatedCost = fromCents(quotedCost);
        request.returnShippingCost = fromCents(0n);
        request.returnShippingFee = fromCents(0n);
        request.estimatedRefundAmount = fromCents(
            this.capRefundAmount(
                toCents(request.refundItemAmount) +
                    toCents(request.refundShippingAmount) -
                    estimatedCustomerDeduction,
                order.totalAmount,
            ),
        );
        request.refundAmount = request.estimatedRefundAmount;
        return this.repository.save(request);
    }

    private isSellerFault(reason: OrderReturnReason): boolean {
        return [
            OrderReturnReason.DAMAGED,
            OrderReturnReason.WRONG_ITEM,
            OrderReturnReason.MISSING_ITEM,
            OrderReturnReason.NOT_AS_DESCRIBED,
        ].includes(reason);
    }

    // Các lý do lỗi hàng quy trách nhiệm shop, đổi ý do khách chịu; OTHER được seller phân loại ở bước duyệt.
    private getFixedShippingPayer(
        reason: OrderReturnReason,
    ): 'CUSTOMER' | 'SELLER' | null {
        if (this.isSellerFault(reason)) return 'SELLER';
        if (reason === OrderReturnReason.CHANGE_OF_MIND) return 'CUSTOMER';
        return null;
    }

    // Phân bổ phí vận chuyển theo tỷ trọng giá trị item để đơn nhiều shop không bị hoàn phí trùng.
    private calculateShippingRefund(
        order: {
            shippingFee: string;
            subtotal: string;
            shippingFeeBreakdown?: Array<Record<string, unknown>>;
            items?: Array<{
                id: string;
                sellerShopId: string | null;
                lineTotal: string;
            }>;
        },
        itemIds: string[],
        itemAmount: bigint,
        reason: OrderReturnReason,
        shopId: string,
    ): bigint {
        if (!this.isSellerFault(reason)) return 0n;
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
            (shippingFee * cappedItemAmount + allocationBase / 2n) /
            allocationBase;
        return this.roundVnd(proportionalAmount);
    }

    // Làm tròn tiền VND về đồng ngay khi chốt snapshot để mọi service và UI dùng cùng một giá trị.
    private roundVnd(value: bigint): bigint {
        return ((value + 50n) / 100n) * 100n;
    }

    // Khóa số tiền refund trong khoảng từ 0 đến tổng tiền gốc để không thể hoàn vượt giao dịch đã thu.
    private capRefundAmount(
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

    // Phát snapshot sau commit; request mới ưu tiên mô tả Customer, các bước sau dùng ghi chú xử lý gần nhất.
    private async publish(
        request: OrderReturnRequest,
        orderNumber: string,
        customerUserId: string,
        eventName: ReturnEventName,
        noteOverride?: string | null,
    ): Promise<void> {
        if (!orderNumber) return;
        await this.events.publishReturnChanged({
            eventName,
            returnId: request.id,
            orderId: request.orderId,
            orderNumber,
            shopId: request.shopId,
            customerUserId,
            sellerUserId: request.sellerUserId,
            status: request.status,
            refundAmount: request.refundAmount,
            reason: request.reason,
            note: noteOverride ?? request.reviewNote,
        });
    }
}

type ReturnEventName =
    | 'return.requested'
    | 'return.approved'
    | 'return.rejected'
    | 'return.cancelled'
    | 'return.in_transit'
    | 'return.received'
    | 'return.inspection.passed'
    | 'return.inspection.failed';
