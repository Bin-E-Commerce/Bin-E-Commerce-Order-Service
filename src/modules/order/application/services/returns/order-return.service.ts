// File này điều phối toàn bộ vòng đời yêu cầu hoàn hàng trong Order Service.
// Service sở hữu ownership, state transition và số tiền hoàn; vận đơn/repository media là boundary của service khác.

import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import {
    ACTIVE_ORDER_RETURN_STATUSES,
    OrderReturnStatus,
} from '@/database/returns/enums/order-return-status.enum';
import { Order } from '@/database/order/entities/order.entity';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderDeliveryConfirmationStatus } from '@/database/delivery/enums/order-delivery-confirmation-status.enum';
import { OrderRepository } from '@/modules/order/infrastructure/repositories/orders/order.repository';
import { RETURN_REQUEST_CANCELLATION_REPOSITORY } from '@/modules/order/application/contracts/return-request-cancellation.repository';
import type { ReturnRequestCancellationRepositoryPort } from '@/modules/order/application/contracts/return-request-cancellation.repository';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import {
    fromCents,
    toCents,
} from '@/modules/order/application/utils/money/order-money.util';
import {
    ShippingClient,
    type GhnAddressSelectionInput,
} from '@/modules/order/application/clients/shipping.client';
import type {
    CreateOrderReturnDto,
    InspectOrderReturnDto,
    ReviewOrderReturnDto,
} from '@/modules/order/presentation/dto/orders/order-return.dto';
import type { SellerOrderUserContext } from '@/modules/order/application/types/order/seller-order-user-context.type';
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import { Inject } from '@nestjs/common';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import { ORDER_RETURN_SHIPMENT_REPOSITORY } from '@/modules/order/application/contracts/order-return-shipment.repository';
import type { OrderReturnShipmentRepositoryPort } from '@/modules/order/application/contracts/order-return-shipment.repository';
import type { ReturnShipmentSyncRecord } from '@/modules/order/application/types/returns/return-shipment-sync.type';
import type { ReturnRefundCalculationOrderSnapshot } from '@/modules/order/application/types/returns/return-refund-calculation.type';
import type { SellerReturnFinancePreview } from '@/modules/order/application/types/returns/seller-return-finance-preview.type';
import { SellerWalletDebtService } from '@/modules/order/application/services/finance/seller-wallet-debt.service';
import { AuthClient } from '@/modules/order/application/clients/auth.client';
import type { RefundBankAccountInput } from '@/modules/order/application/types/order/refund-bank-account.type';
import {
    calculateReturnShippingRefund,
    capReturnRefundAmount,
    getFixedReturnShippingPayer,
    isSellerReturnFaultReason,
    roundReturnVnd,
} from '@/modules/order/application/utils/returns/return-refund-calculation.util';

const REFUND_ACCOUNT_HOLDER_PATTERN =
    /^\p{L}[\p{L}\p{M}]*(?: [\p{L}][\p{L}\p{M}]*)*$/u;
const SELLER_REDACTED_RETURN_FIELDS = new Set([
    'refundBankAccountId',
    'refundBankCode',
    'refundBankName',
    'refundAccountHolder',
    'refundAccountNumber',
]);

@Injectable()
export class OrderReturnService {
    private readonly logger = new Logger(OrderReturnService.name);

    constructor(
        @InjectRepository(OrderReturnRequest)
        private readonly repository: Repository<OrderReturnRequest>,
        private readonly orders: OrderRepository,
        private readonly sellerShopClient: SellerShopClient,
        private readonly events: OrderEventsService,
        private readonly shippingClient: ShippingClient,
        @Optional() private readonly dataSource?: DataSource,
        @Optional() private readonly paymentService?: PaymentService,
        @Optional()
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly sellerWalletRepository?: SellerWalletRepositoryPort,
        @Optional()
        @Inject(ORDER_RETURN_SHIPMENT_REPOSITORY)
        private readonly returnShipmentRepository?: OrderReturnShipmentRepositoryPort,
        @Optional()
        @Inject(RETURN_REQUEST_CANCELLATION_REPOSITORY)
        private readonly returnRequestCancellationRepository?: ReturnRequestCancellationRepositoryPort,
        @Optional()
        private readonly sellerWalletDebtService?: SellerWalletDebtService,
        @Optional() private readonly authClient?: AuthClient,
    ) {}

    // Tạo một request cho đúng một shop; UI nhiều shop phải gọi lại endpoint theo từng nhóm item.
    // Chỉ nhận đơn DELIVERED vì COMPLETED nghĩa là khách đã xác nhận hoàn thành và đóng quyền bắt đầu return mới.
    // Kiểm tra application layer giúp phản hồi nhanh khi quy trình hoàn đang mở.
    // Unique partial index ở database xử lý trường hợp hai request chạy đồng thời sau cùng một lần kiểm tra.
    async create(ownerId: string, orderId: string, dto: CreateOrderReturnDto) {
        const order = await this.orders.findOwnedById(ownerId, orderId);
        if (!order) throw new NotFoundException('Không tìm thấy đơn hàng.');
        if (order.fulfillmentStatus !== OrderFulfillmentStatus.DELIVERED)
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
        if (existing) {
            // Retry chỉ phát lại thông báo cho request còn chờ duyệt; eventId ổn định giúp consumer loại bản trùng.
            if (existing.status === OrderReturnStatus.REQUESTED)
                await this.publishCreatedRequest(
                    existing,
                    order.orderNumber,
                    ownerId,
                );
            return existing;
        }
        // OTHER chỉ được giữ cho request lịch sử đã tồn tại; không cho tạo return mới bỏ qua danh sách lý do chuẩn.
        if (dto.reason === OrderReturnReason.OTHER)
            throw new BadRequestException(
                'Lý do khác không còn được hỗ trợ. Vui lòng chọn một lý do trả hàng phù hợp.',
            );
        // Xác minh tài khoản chỉ cho request mới; retry request đã tạo vẫn idempotent dù hồ sơ ngân hàng được đổi sau đó.
        const refundBankAccount = await this.resolveRefundBankAccount(
            ownerId,
            dto.savedRefundBankAccountId,
        );
        const itemRefundAmount = this.roundVnd(
            itemIds.reduce(
                (sum, itemId) => sum + toCents(itemMap.get(itemId)!.lineTotal),
                0n,
            ),
        );
        const shippingRefundAmount = this.calculateShippingRefund(
            order,
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
            refundBankAccountId: refundBankAccount.id,
            refundBankCode: refundBankAccount.bankCode,
            refundBankName: refundBankAccount.bankName,
            refundAccountHolder: refundBankAccount.accountHolder,
            refundAccountNumber: refundBankAccount.accountNumber,
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
            if (this.dataSource) {
                // Commit request cùng event; lỗi ghi outbox sẽ rollback cả hai để không mất thông báo Seller.
                saved = await this.dataSource.transaction(async (manager) => {
                    const created = await manager
                        .getRepository(OrderReturnRequest)
                        .save(request);
                    await this.publish(
                        created,
                        order.orderNumber,
                        ownerId,
                        'return.requested',
                        created.description,
                        manager,
                    );
                    return created;
                });
            } else {
                // Adapter legacy không cấp transaction vẫn lưu request và thử enqueue event sau khi lưu.
                saved = await this.repository.save(request);
            }
        } catch (error) {
            // Nếu request khác vừa insert cùng order/shop, trả về bản ghi đã tồn tại thay vì tạo workflow thứ hai.
            if (!this.isActiveReturnUniqueViolation(error)) throw error;
            const concurrentRequest = await this.findActiveRequest(
                orderId,
                ownerId,
                shopId,
            );
            if (concurrentRequest) {
                await this.publishCreatedRequest(
                    concurrentRequest,
                    order.orderNumber,
                    ownerId,
                );
                return concurrentRequest;
            }
            throw new ConflictException(
                'Đơn hàng đã có yêu cầu hoàn hàng đang được xử lý.',
            );
        }
        // Gửi mô tả của Customer trong event đầu tiên để notification/email cho Seller có đủ ngữ cảnh xử lý.
        await this.publishCreatedRequest(saved, order.orderNumber, ownerId);
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

    // Hủy nguyên tử request đang chờ shop; nếu request khóa luồng delivery issue thì khôi phục order về DELIVERED/PENDING.
    // Adapter kiểm tra lại trạng thái dưới row lock để seller duyệt đồng thời không bị ghi đè; retry đã hủy không phát event trùng.
    async cancel(ownerId: string, returnId: string) {
        if (!this.returnRequestCancellationRepository)
            throw new ConflictException(
                'Chức năng hủy yêu cầu hoàn hàng chưa sẵn sàng.',
            );

        const result =
            await this.returnRequestCancellationRepository.cancelRequested(
                ownerId,
                returnId,
            );
        if (result.kind === 'NOT_FOUND')
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        if (result.kind === 'NOT_CANCELLABLE')
            throw new ConflictException('Yêu cầu đã được shop xử lý.');
        if (result.kind === 'ALREADY_CANCELLED')
            return this.getForCustomer(ownerId, returnId);

        await this.publish(
            result.snapshot,
            result.snapshot.orderNumber,
            ownerId,
            'return.cancelled',
        );
        return this.getForCustomer(ownerId, returnId);
    }

    // Seller queue chỉ trả request thuộc shop được resolve từ session, đồng thời bổ sung quote cho request legacy.
    async listForSeller(
        currentUser: SellerOrderUserContext,
        status?: OrderReturnStatus,
    ) {
        const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
        // Ưu tiên request mới nhất để seller thấy ngay yêu cầu vừa gửi ở đầu danh sách.
        const requests = await this.repository.find({
            where: { shopId, ...(status ? { status } : {}) },
            order: { createdAt: 'DESC' },
        });
        const sellerRequests = await Promise.all(
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
        return sellerRequests.map((request) =>
            this.toSellerSafeRequest(request),
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
        // Dữ liệu cũ OTHER có thể đã được duyệt trước migration nhưng chưa chọn payer;
        // chỉ mở lại đúng trạng thái AWAITING_SHIPMENT này để seller phân loại, không hồi sinh các return đã chạy vận chuyển.
        const isLegacyOtherAwaitingReview =
            request.status === OrderReturnStatus.AWAITING_SHIPMENT &&
            request.reason === OrderReturnReason.OTHER &&
            request.returnShippingPayer === null;
        if (isLegacyOtherAwaitingReview) {
            const shipment =
                await this.shippingClient?.getReturnShipmentState(returnId);
            // READY_TO_SHIP/PICKUP_ASSIGNED còn có thể đổi payer trước khi carrier nhận kiện; các mốc sau đó phải giữ nguyên audit phí.
            if (
                shipment &&
                !['READY_TO_SHIP', 'PICKUP_ASSIGNED'].includes(shipment.status)
            )
                throw new ConflictException(
                    'Vận đơn hoàn đã chạy, không thể phân loại lại bên chịu phí.',
                );
        }
        if (
            request.status !== OrderReturnStatus.REQUESTED &&
            !isLegacyOtherAwaitingReview
        )
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
        return this.toSellerSafeRequest(saved);
    }

    // Trả preview tài chính tối thiểu cho request thuộc shop hiện tại; không cấp quyền đọc lịch sử ví cho nhân viên xử lý return.
    async getSellerReturnFinancePreview(
        currentUser: SellerOrderUserContext,
        returnId: string,
        selectedPayer?: 'CUSTOMER' | 'SELLER',
    ): Promise<SellerReturnFinancePreview> {
        // Resolve tenant bằng identity đã xác minh; route không nhận shopId từ browser.
        const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
        const request = await this.repository.findOne({
            where: { id: returnId, shopId },
        });
        // Trả cùng lỗi không tìm thấy cho ID ngoài shop để không tiết lộ request của tenant khác.
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        // Snapshot chỉ hợp lệ trước khi duyệt; request đổi state giữa lúc mở dialog sẽ phải tải lại.
        if (request.status !== OrderReturnStatus.REQUESTED) {
            throw new ConflictException(
                'Chỉ xem được dự báo ví cho yêu cầu đang chờ shop duyệt.',
            );
        }

        // Lý do cố định không thể đổi payer bằng query; OTHER phải xác nhận shop là bên chịu phí.
        const fixedPayer = this.getFixedShippingPayer(
            request.reason as OrderReturnReason,
        );
        const resolvedPayer =
            fixedPayer ?? selectedPayer ?? request.returnShippingPayer;
        if (resolvedPayer !== 'SELLER') {
            throw new ConflictException(
                'Dự báo ví chỉ áp dụng khi shop là bên chịu phí hoàn.',
            );
        }
        if (!this.sellerWalletRepository || !this.sellerWalletDebtService) {
            throw new Error(
                'Seller wallet services are required to preview return fees.',
            );
        }

        // Lượt đi dùng đúng khoản phí giao ban đầu sẽ hoàn cho khách; lượt về dùng quote GHN đã lưu trên request.
        // Hai chiều chỉ cộng vào dự báo khi shop là payer, còn số thực tế vẫn được ghi theo từng sự kiện cuối cùng.
        const estimatedOutboundShippingFee = toCents(
            request.refundShippingAmount,
        );
        const estimatedReturnShippingFee = toCents(
            request.returnShippingEstimatedCost,
        );
        const estimatedShippingFee =
            estimatedOutboundShippingFee + estimatedReturnShippingFee;

        // Đọc snapshot ví trước vì bước này đối soát ledger đã chốt; debt snapshot sau đó phải thấy balance vừa được sửa.
        const wallet = await this.sellerWalletRepository.getSnapshot(
            shopId,
            1,
            1,
        );
        const debt = await this.sellerWalletDebtService.getShopSnapshot(shopId);
        return {
            availableBalance: wallet.availableBalance,
            currentDebtBalance: debt.debtBalance,
            estimatedOutboundShippingFee: fromCents(
                estimatedOutboundShippingFee,
            ),
            estimatedReturnShippingFee: fromCents(estimatedReturnShippingFee),
            estimatedShippingFee: fromCents(estimatedShippingFee),
            debtLimit: debt.debtLimit,
            shopLocked: debt.shopLocked,
        };
    }

    // Callback carrier mở bước tracking khi đã nhận kiện hoặc nhận lại vận đơn retry.
    // SHIPMENT_FAILED được phép quay về IN_TRANSIT; các state khác bị từ chối để event cũ không hồi sinh request đã đóng.
    async markInTransit(returnId: string) {
        if (!this.returnShipmentRepository)
            throw new BadRequestException(
                'Order return shipment repository chưa sẵn sàng.',
            );
        const record =
            await this.returnShipmentRepository.markShipmentInTransit(returnId);
        if (record.changed)
            await this.publishShipmentSync(record, 'return.in_transit');
        return record;
    }

    // Đưa lỗi carrier vào state riêng để UI hiển thị lý do và nút thử tạo lại vận đơn.
    async markShipmentFailed(returnId: string, note: string) {
        if (!this.returnShipmentRepository)
            throw new BadRequestException(
                'Order return shipment repository chưa sẵn sàng.',
            );
        const record = await this.returnShipmentRepository.markShipmentFailed(
            returnId,
            note,
        );
        if (record.changed)
            await this.publishShipmentSync(record, 'return.shipment_failed');
        return record;
    }

    // Khôi phục request sang chờ gửi hàng sau khi retry carrier đã được lưu bền vững ở Shipping Service.
    async markShipmentRetryStarted(returnId: string) {
        if (!this.returnShipmentRepository)
            throw new BadRequestException(
                'Order return shipment repository chưa sẵn sàng.',
            );
        const record =
            await this.returnShipmentRepository.markShipmentRetryStarted(
                returnId,
            );
        if (record.changed)
            await this.publishShipmentSync(
                record,
                'return.shipment_retry_started',
            );
        return record;
    }

    // Callback nhận hàng lặp sau kiểm tra/refund phải trả snapshot hiện tại, không làm request quay về RECEIVED.
    async markReceived(returnId: string) {
        const request = await this.repository.findOne({
            where: { id: returnId },
        });
        if (!request)
            throw new NotFoundException('Không tìm thấy yêu cầu hoàn hàng.');
        // Các trạng thái này chỉ xuất hiện sau khi shop đã nhận kiện; callback đến trễ không được hồi sinh state cũ.
        if (
            [
                OrderReturnStatus.RECEIVED,
                OrderReturnStatus.INSPECTION_PASSED,
                OrderReturnStatus.INSPECTION_FAILED,
                OrderReturnStatus.REFUND_PENDING,
                OrderReturnStatus.REFUND_FAILED,
                OrderReturnStatus.REFUNDED,
            ].includes(request.status)
        )
            return request;
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

    // Shipping Service nhận snapshot cho request đã duyệt hoặc lỗi shipment cần retry; các state khác không thể tạo nhãn.
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
                OrderReturnStatus.SHIPMENT_FAILED,
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

    // Callback GHN chốt chi phí carrier và tiền refund, nhưng không đồng nghĩa seller đã nhận lại hàng đạt.
    // Ghi platform ledger trước để chi phí thật không bị mất; seller ledger chỉ được ghi sau inspection pass.
    // Retry cùng amount tự bù ledger thiếu, còn amount khác bị từ chối để không sửa lịch sử tài chính.
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
            // Callback lặp luôn bù sổ nền tảng; sổ seller chỉ được bù nếu yêu cầu đã qua kiểm tra đạt.
            if (actualCost > 0n) {
                if (!this.sellerWalletRepository) {
                    throw new Error(
                        'Seller wallet repository is required to record return shipping fees.',
                    );
                }
                await this.sellerWalletRepository.recordReturnShippingPlatformCost(
                    returnId,
                    fromCents(actualCost),
                );
                if (
                    request.returnShippingPayer === 'SELLER' &&
                    request.inspectionPassed === true
                ) {
                    await this.sellerWalletRepository.recordReturnShippingFee(
                        returnId,
                        fromCents(actualCost),
                    );
                    // Callback đến sau khi kiểm hàng vẫn phải ghi phần giao ban đầu đã hoàn cho khách.
                    await this.sellerWalletRepository.recordReturnOutboundShippingFee(
                        returnId,
                    );
                }
            }
            if (
                request.status === OrderReturnStatus.INSPECTION_FAILED &&
                request.returnShippingPayer === 'CUSTOMER' &&
                actualCost > 0n
            ) {
                if (!this.sellerWalletRepository)
                    throw new Error(
                        'Seller wallet repository is required to record return-shipping receivables.',
                    );
                await this.sellerWalletRepository.recordCustomerReturnShippingReceivable(
                    returnId,
                    fromCents(actualCost),
                );
            }
            return request;
        }
        const shipmentStartedStatuses = [
            OrderReturnStatus.AWAITING_SHIPMENT,
            OrderReturnStatus.IN_TRANSIT,
            OrderReturnStatus.RECEIVED,
            OrderReturnStatus.INSPECTION_PASSED,
            OrderReturnStatus.INSPECTION_FAILED,
            OrderReturnStatus.REFUND_PENDING,
            OrderReturnStatus.REFUND_FAILED,
            OrderReturnStatus.REFUNDED,
        ];
        // Cho phép callback phí đến trễ sau lúc shop nhận/kiểm tra kiện; request đã bị từ chối hoặc hủy vẫn bị chặn.
        if (!shipmentStartedStatuses.includes(request.status)) {
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
        const outboundShippingRefund = this.roundVnd(
            toCents(request.refundShippingAmount),
        );
        const finalRefund =
            itemAmount + outboundShippingRefund - customerDeduction;
        const cappedRefund = this.capRefundAmount(
            finalRefund,
            order.totalAmount,
        );
        // Không sửa số tiền đã chuyển cho khách; nếu khách chịu phí mà callback đến sau REFUNDED thì cần đối soát thủ công.
        if (
            request.status === OrderReturnStatus.REFUNDED &&
            toCents(request.refundAmount) !== cappedRefund
        ) {
            throw new ConflictException(
                'Phí hoàn đến sau khi đã xác nhận refund và làm thay đổi số tiền; cần đối soát thủ công.',
            );
        }
        // Ghi chi phí carrier sau khi xác thực refund; writer riêng không chạm ví shop trước khi có kết quả kiểm hàng.
        if (actualCost > 0n) {
            if (!this.sellerWalletRepository) {
                throw new Error(
                    'Seller wallet repository is required to record return shipping fees.',
                );
            }
            await this.sellerWalletRepository.recordReturnShippingPlatformCost(
                returnId,
                fromCents(actualCost),
            );
        }
        request.returnShippingCost = fromCents(actualCost);
        request.returnShippingFee = fromCents(customerDeduction);
        request.returnShippingFinalizedAt = new Date();
        request.customerReturnShippingReceivableAmount = fromCents(0n);
        request.refundAmount = fromCents(cappedRefund);
        const saved = await this.repository.save(request);
        // Nếu GHN chốt phí trễ, ghi nợ seller chỉ cho hồ sơ đã đạt kiểm tra; trạng thái fail được miễn khoản nợ này.
        if (
            actualCost > 0n &&
            saved.returnShippingPayer === 'SELLER' &&
            saved.inspectionPassed === true
        ) {
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record return shipping fees.',
                );
            await this.sellerWalletRepository.recordReturnShippingFee(
                returnId,
                fromCents(actualCost),
            );
        }
        if (
            saved.returnShippingPayer === 'SELLER' &&
            saved.inspectionPassed === true
        ) {
            // Nếu kiểm hàng xong trước callback GHN, vẫn ghi khoản giao ban đầu ngay; phí về sẽ được ghi khi GHN chốt.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record outbound return shipping fees.',
                );
            await this.sellerWalletRepository.recordReturnOutboundShippingFee(
                returnId,
            );
        }
        // Nếu phí khách trả chỉ được chốt sau khi shop đã từ chối hoàn, đồng bộ khoản phải thu thay vì trừ ví shop.
        if (
            saved.status === OrderReturnStatus.INSPECTION_FAILED &&
            saved.returnShippingPayer === 'CUSTOMER' &&
            actualCost > 0n
        ) {
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record return-shipping receivables.',
                );
            await this.sellerWalletRepository.recordCustomerReturnShippingReceivable(
                returnId,
                fromCents(actualCost),
            );
        }
        return saved;
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

    // Khóa request để chỉ một kết quả inspection thắng; pass đảo tiền hàng và ghi phí shop sau khi trạng thái được lưu.
    // Retry cùng kết quả bù ledger lỗi mà không phát event lần hai; fail hoàn lại khoản debit cũ nếu callback đến sớm.
    // Chi phí carrier của nền tảng và khoản phải thu khách chịu phí vẫn được xử lý riêng theo payer.
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
            if (
                request.status === OrderReturnStatus.REFUND_PENDING &&
                dto.passed
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
        if (dto.passed && toCents(result.saved.refundItemAmount) > 0n) {
            // Hàng đã được shop nhận và xác nhận đạt nên đảo phần sale ngay; writer idempotent cũng sửa được retry sau lỗi ví.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to reverse returned item sales.',
                );
            await this.sellerWalletRepository.reverseReturnSaleAtInspection(
                result.saved.id,
            );
        }
        if (result.eventType)
            await this.publish(
                result.saved,
                result.orderNumber,
                result.ownerId,
                result.eventType,
            );
        if (
            !dto.passed &&
            result.saved.returnShippingPayer === 'SELLER' &&
            result.saved.returnShippingFinalizedAt &&
            toCents(result.saved.returnShippingCost) > 0n
        ) {
            // Gỡ khoản nợ cũ nếu GHN callback đã ghi trước khi shop kiểm hàng; phí carrier nền tảng không bị hoàn lại.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to reverse failed return-shipping fees.',
                );
            await this.sellerWalletRepository.reverseFailedReturnShippingFee(
                result.saved.id,
            );
        }
        if (!dto.passed && result.saved.returnShippingPayer === 'SELLER') {
            // Bù an toàn nếu một retry cũ đã ghi nợ lượt đi trước khi trạng thái kiểm tra cuối được lưu.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to reverse outbound return shipping fees.',
                );
            await this.sellerWalletRepository.reverseFailedReturnOutboundShippingFee(
                result.saved.id,
            );
        }
        if (
            dto.passed &&
            result.saved.returnShippingPayer === 'SELLER' &&
            toCents(result.saved.refundShippingAmount) > 0n
        ) {
            // Khi hàng lỗi shop được xác nhận đạt, phí giao ban đầu đã hoàn cho khách được ghi riêng khỏi phí GHN chiều về.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record outbound return shipping fees.',
                );
            await this.sellerWalletRepository.recordReturnOutboundShippingFee(
                result.saved.id,
            );
        }
        if (
            dto.passed &&
            result.saved.returnShippingPayer === 'SELLER' &&
            result.saved.returnShippingFinalizedAt &&
            toCents(result.saved.returnShippingCost) > 0n
        ) {
            // Sau khi transaction lưu trạng thái đạt, source key giữ debit một lần và cho retry tự bù nếu ghi ví lỗi.
            if (!this.sellerWalletRepository)
                throw new Error(
                    'Seller wallet repository is required to record return shipping fees.',
                );
            await this.sellerWalletRepository.recordReturnShippingFee(
                result.saved.id,
                result.saved.returnShippingCost,
            );
        }
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
        // Pay2S/COD đều chờ admin xác nhận chuyển khoản thủ công sau khi số tiền hoàn đã được chốt.
        return this.toSellerSafeRequest(result.saved);
    }

    // Chỉ Seller nhận snapshot vận hành của return; tài khoản ngân hàng là PII chỉ Customer và Admin được đọc.
    private toSellerSafeRequest(
        request: OrderReturnRequest,
    ): Omit<
        OrderReturnRequest,
        | 'refundBankAccountId'
        | 'refundBankCode'
        | 'refundBankName'
        | 'refundAccountHolder'
        | 'refundAccountNumber'
    > {
        return Object.fromEntries(
            Object.entries(request).filter(
                ([field]) => !SELLER_REDACTED_RETURN_FIELDS.has(field),
            ),
        ) as Omit<
            OrderReturnRequest,
            | 'refundBankAccountId'
            | 'refundBankCode'
            | 'refundBankName'
            | 'refundAccountHolder'
            | 'refundAccountNumber'
        >;
    }

    // Chỉ lấy snapshot từ Auth theo ID của Customer; không nhận số tài khoản đầy đủ do browser tự gửi.
    private async resolveRefundBankAccount(
        ownerId: string,
        accountId: string,
    ): Promise<RefundBankAccountInput & { id: string }> {
        if (!this.authClient) {
            throw new ServiceUnavailableException(
                'Auth Service chưa sẵn sàng để xác minh tài khoản nhận hoàn.',
            );
        }
        const account = await this.authClient.getOwnedRefundBankAccount(
            ownerId,
            accountId,
        );
        const normalized = {
            id: typeof account.id === 'string' ? account.id.trim() : '',
            bankCode:
                typeof account.bankCode === 'string'
                    ? account.bankCode.trim().toLowerCase()
                    : '',
            bankName:
                typeof account.bankName === 'string'
                    ? account.bankName.trim()
                    : '',
            accountHolder:
                typeof account.accountHolder === 'string'
                    ? account.accountHolder
                          .normalize('NFC')
                          .trim()
                          .replace(/\s+/gu, ' ')
                          .toLocaleUpperCase('vi-VN')
                    : '',
            accountNumber:
                typeof account.accountNumber === 'string'
                    ? account.accountNumber.trim()
                    : '',
        };
        // Auth sở hữu hồ sơ gốc, Order vẫn xác nhận shape trước khi chụp vào hồ sơ hoàn bất biến.
        if (
            normalized.id.toLowerCase() !== accountId.toLowerCase() ||
            !/^[a-z0-9-]{2,50}$/.test(normalized.bankCode) ||
            normalized.bankName.length < 2 ||
            normalized.bankName.length > 100 ||
            !REFUND_ACCOUNT_HOLDER_PATTERN.test(normalized.accountHolder) ||
            !/^\d{6,30}$/.test(normalized.accountNumber)
        ) {
            throw new BadRequestException(
                'Tài khoản nhận hoàn đã lưu không còn hợp lệ. Hãy cập nhật hồ sơ ngân hàng rồi thử lại.',
            );
        }
        return normalized;
    }

    // Lỗi sản phẩm cần evidence để shop xác minh; lý do đổi ý được tạo request với mảng rỗng.
    // Giới hạn vẫn áp dụng cho mọi lý do để client không lách quota bằng cách chọn đổi ý.
    private validateEvidence(dto: CreateOrderReturnDto): void {
        const evidence = dto.evidence ?? [];
        const images = evidence.filter((item) => item.type === 'image');
        const videos = evidence.filter((item) => item.type === 'video');
        // Mọi lý do lỗi phải có ít nhất một tệp; CHANGE_OF_MIND là ngoại lệ đã chốt trong chính sách trả hàng.
        if (
            dto.reason !== OrderReturnReason.CHANGE_OF_MIND &&
            evidence.length === 0
        )
            throw new BadRequestException(
                'Yêu cầu hoàn hàng cần ít nhất một ảnh hoặc video bằng chứng.',
            );
        if (images.length > 5 || videos.length > 1)
            throw new BadRequestException(
                'Tối đa 5 ảnh và 1 video cho bằng chứng hoàn hàng.',
            );
    }

    // Gửi notification sau khi request đã lưu; lỗi Kafka không được làm API báo thất bại rồi khiến client xóa media đang được request tham chiếu.
    // Request vẫn hiển thị qua queue Seller đọc trực tiếp từ database; retry tạo request sẽ thử phát lại event idempotent.
    private async publishCreatedRequest(
        request: OrderReturnRequest,
        orderNumber: string,
        ownerId: string,
    ): Promise<void> {
        try {
            await this.publish(
                request,
                orderNumber,
                ownerId,
                'return.requested',
                request.description,
            );
        } catch (error) {
            this.logger.error(
                `Không gửi được thông báo yêu cầu hoàn ${request.id}; request đã lưu và sẽ được Seller queue đồng bộ.`,
                error instanceof Error ? error.stack : String(error),
            );
        }
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
        return isSellerReturnFaultReason(reason);
    }

    // Các lý do lỗi hàng quy trách nhiệm shop, đổi ý do khách chịu; OTHER được seller phân loại ở bước duyệt.
    private getFixedShippingPayer(
        reason: OrderReturnReason,
    ): 'CUSTOMER' | 'SELLER' | null {
        return getFixedReturnShippingPayer(reason);
    }

    // Phân bổ phí vận chuyển theo tỷ trọng giá trị item để đơn nhiều shop không bị hoàn phí trùng.
    private calculateShippingRefund(
        order: ReturnRefundCalculationOrderSnapshot,
        itemAmount: bigint,
        reason: OrderReturnReason,
        shopId: string,
    ): bigint {
        return calculateReturnShippingRefund(order, itemAmount, reason, shopId);
    }

    // Làm tròn tiền VND về đồng ngay khi chốt snapshot để mọi service và UI dùng cùng một giá trị.
    private roundVnd(value: bigint): bigint {
        return roundReturnVnd(value);
    }

    // Khóa số tiền refund trong khoảng từ 0 đến tổng tiền gốc để không thể hoàn vượt giao dịch đã thu.
    private capRefundAmount(
        value: bigint,
        originalOrderAmount?: string | null,
    ): bigint {
        return capReturnRefundAmount(value, originalOrderAmount);
    }

    // Phát snapshot sau commit; request mới ưu tiên mô tả Customer, các bước sau dùng ghi chú xử lý gần nhất.
    private async publish(
        request: Pick<
            OrderReturnRequest,
            | 'id'
            | 'orderId'
            | 'shopId'
            | 'sellerUserId'
            | 'status'
            | 'refundAmount'
            | 'reason'
            | 'reviewNote'
        >,
        orderNumber: string,
        customerUserId: string,
        eventName: ReturnEventName,
        noteOverride?: string | null,
        manager?: EntityManager,
    ): Promise<void> {
        if (!orderNumber) return;
        await this.events.publishReturnChanged(
            {
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
            },
            manager,
        );
    }

    // Chỉ phát event cho transition mới và lấy order number qua Order repository; shipment không nhận full order snapshot.
    private async publishShipmentSync(
        record: ReturnShipmentSyncRecord,
        eventName: ReturnEventName,
    ): Promise<void> {
        const order = await this.orders.findOwnedById(
            record.ownerId,
            record.orderId,
        );
        await this.publish(
            record,
            order?.orderNumber ?? '',
            record.ownerId,
            eventName,
            record.shipmentFailureNote,
        );
    }
}

type ReturnEventName =
    | 'return.requested'
    | 'return.approved'
    | 'return.rejected'
    | 'return.cancelled'
    | 'return.in_transit'
    | 'return.shipment_failed'
    | 'return.shipment_retry_started'
    | 'return.received'
    | 'return.inspection.passed'
    | 'return.inspection.failed';
