// File này đóng gói persistence query của Order để application service không phụ thuộc TypeORM API.

import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Not, Repository } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import type { RefundBankAccountInput } from '@/modules/order/application/types/order/refund-bank-account.type';
import type { SellerOrderListQueryDto } from '@/modules/order/presentation/dto/orders/seller-order-list-query.dto';
import type {
    CustomerOrderTabCounts,
    SellerOrderTabCounts,
} from '@/modules/order/application/types/order/order-response.type';

// Giữ đơn Sandbox trong Seller Center khi Pay2S đã thu tiền, đang hoàn, hoàn lỗi hoặc hoàn xong.
const SELLER_VISIBLE_SANDBOX_PAYMENT_STATUSES = [
    'PAID',
    'REFUND_PENDING',
    'REFUND_FAILED',
    'REFUNDED',
] as const;

// Các trạng thái này cho biết item đã đi vào quy trình hoàn thực tế; item bị từ chối hoặc customer tự hủy vẫn là một lượt bán hợp lệ.
const RETURN_STATUSES_EXCLUDED_FROM_SALES = [
    OrderReturnStatus.AWAITING_SHIPMENT,
    OrderReturnStatus.IN_TRANSIT,
    OrderReturnStatus.SHIPMENT_FAILED,
    OrderReturnStatus.RECEIVED,
    OrderReturnStatus.INSPECTION_FAILED,
    OrderReturnStatus.REFUND_PENDING,
    OrderReturnStatus.REFUND_FAILED,
    OrderReturnStatus.REFUNDED,
];

// Cung cấp các query theo ownership và idempotency, không cho caller truyền owner tùy ý vào service khác.
@Injectable()
export class OrderRepository {
    constructor(
        @InjectRepository(Order) private readonly repository: Repository<Order>,
        @InjectRepository(OrderReturnRequest)
        private readonly returnRepository: Repository<OrderReturnRequest>,
        private readonly dataSource?: DataSource,
    ) {}

    // Hủy order và chuyển khoản Pay2S đã thu sang hàng chờ hoàn trong cùng transaction.
    // Khóa order trước attempt để IPN, hủy và đối soát không thể cùng quyết định trạng thái tiền.
    // Retry trên order đã hủy vẫn sửa được dữ liệu legacy PAID mà không ghi lịch sử hủy lần hai.
    async cancelOwnedOrder(
        ownerId: string,
        orderId: string,
        reason: string | null,
        refundBankAccount?: RefundBankAccountInput,
        requireRefundBankAccount = false,
    ): Promise<{ didCancel: boolean; refundPending: boolean }> {
        if (!this.dataSource)
            throw new ConflictException(
                'Order database transaction is not available.',
            );
        return this.dataSource.transaction(async (manager) => {
            const orderRepository = manager.getRepository(Order);
            const order = await orderRepository
                .createQueryBuilder('order')
                .where('order.id = :orderId', { orderId })
                .andWhere('order.owner_id = :ownerId', { ownerId })
                .setLock('pessimistic_write')
                .getOne();
            if (!order) throw new NotFoundException('Không tìm thấy đơn hàng.');

            if (order.status === OrderStatus.CANCELLED) {
                if (
                    order.paymentMethod === PaymentMethod.PAY2S &&
                    order.paymentStatus === PaymentStatus.PAID
                ) {
                    await this.markPaidAttemptRefundPending(
                        manager,
                        order.id,
                        refundBankAccount,
                        requireRefundBankAccount,
                    );
                    order.paymentStatus = PaymentStatus.REFUND_PENDING;
                    await orderRepository.save(order);
                }
                return {
                    didCancel: false,
                    refundPending:
                        order.paymentStatus === PaymentStatus.REFUND_PENDING,
                };
            }

            if (
                order.status !== OrderStatus.CONFIRMED ||
                order.fulfillmentStatus !== OrderFulfillmentStatus.TO_SHIP
            )
                throw new ConflictException(
                    'Đơn hàng không còn ở trạng thái có thể hủy.',
                );

            const refundPending =
                order.paymentMethod === PaymentMethod.PAY2S &&
                order.paymentStatus === PaymentStatus.PAID;
            if (refundPending) {
                await this.markPaidAttemptRefundPending(
                    manager,
                    order.id,
                    refundBankAccount,
                    requireRefundBankAccount,
                );
                order.paymentStatus = PaymentStatus.REFUND_PENDING;
            }
            order.status = OrderStatus.CANCELLED;
            order.fulfillmentStatus = OrderFulfillmentStatus.CANCELLED;
            order.cancelReason = reason;
            order.cancelledAt = new Date();
            await orderRepository.save(order);
            await manager.getRepository(OrderStatusHistory).save({
                orderId,
                fromStatus: OrderStatus.CONFIRMED,
                toStatus: OrderStatus.CANCELLED,
                reason: reason ?? 'Khách hàng hủy đơn.',
            });
            return { didCancel: true, refundPending };
        });
    }

    // Chỉ đổi attempt đã thu tiền; PENDING/FAILED attempt không được biến thành nghĩa vụ hoàn giả.
    private async markPaidAttemptRefundPending(
        manager: import('typeorm').EntityManager,
        orderId: string,
        refundBankAccount?: RefundBankAccountInput,
        requireRefundBankAccount = false,
    ): Promise<void> {
        const attempt = await manager
            .getRepository(PaymentAttempt)
            .createQueryBuilder('attempt')
            .where('attempt.order_id = :orderId', { orderId })
            .andWhere('attempt.status = :status', { status: 'PAID' })
            .orderBy('attempt.created_at', 'DESC')
            .setLock('pessimistic_write')
            .getOne();
        // Chặn tạo trạng thái hoàn nếu dữ liệu thanh toán thiếu attempt để admin không mất dấu khoản tiền.
        if (!attempt) {
            if (requireRefundBankAccount)
                throw new ConflictException(
                    'Không tìm thấy giao dịch Pay2S để lưu thông tin nhận hoàn.',
                );
            return;
        }
        // Khóa attempt cùng transaction order để tài khoản nhận tiền luôn gắn với đúng giao dịch được đưa vào refund queue.
        if (requireRefundBankAccount && !refundBankAccount) {
            throw new ConflictException(
                'Đơn đã thanh toán; vui lòng nhập tài khoản ngân hàng nhận hoàn rồi thử lại.',
            );
        }
        if (refundBankAccount) {
            attempt.refundBankCode = refundBankAccount.bankCode;
            attempt.refundBankName = refundBankAccount.bankName;
            attempt.refundAccountHolder = refundBankAccount.accountHolder;
            attempt.refundAccountNumber = refundBankAccount.accountNumber;
        }
        attempt.status = 'REFUND_PENDING';
        await manager.getRepository(PaymentAttempt).save(attempt);
    }

    // Tìm order cũ để retry cùng key trả đúng kết quả và không reserve stock lần hai.
    findByIdempotency(
        ownerId: string,
        idempotencyKey: string,
    ): Promise<Order | null> {
        return this.repository.findOne({
            where: { ownerId, idempotencyKey },
            relations: { items: true, statusHistory: true },
        });
    }

    // Chỉ đọc chi tiết order khi id đồng thời thuộc owner từ JWT context.
    findOwnedById(ownerId: string, orderId: string): Promise<Order | null> {
        return this.repository.findOne({
            where: { id: orderId, ownerId },
            relations: { items: true, statusHistory: true },
        });
    }

    // Đơn Pay2S chưa thanh toán không được tính là đơn seller cần lấy hàng.
    // Dùng cùng điều kiện ở danh sách và badge để số lượng tab khớp dữ liệu hiển thị.
    findOwnedPage(
        ownerId: string,
        page: number,
        pageSize: number,
        status?: OrderStatus,
        stage?: OrderFulfillmentStatus,
    ): Promise<[Order[], number]> {
        const where: FindOptionsWhere<Order> = stage
            ? {
                  ownerId,
                  fulfillmentStatus: stage,
                  ...(stage === OrderFulfillmentStatus.TO_SHIP
                      ? { status: Not(OrderStatus.PENDING) }
                      : {}),
              }
            : status
              ? { ownerId, status }
              : { ownerId };
        return this.repository.findAndCount({
            where,
            relations: { items: true },
            order: { createdAt: 'DESC' },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });
    }

    // Đếm một lần cho toàn bộ nhóm tab của owner; dùng FILTER giúp UI hiển thị badge nhất quán mà không cần gọi nhiều endpoint.
    async countOwnedTabs(ownerId: string): Promise<CustomerOrderTabCounts> {
        const row = await this.repository
            .createQueryBuilder('order')
            .select('COUNT(*)', 'total')
            .addSelect(
                'COUNT(*) FILTER (WHERE order.status = :pendingStatus)',
                'pendingPayment',
            )
            // Chỉ đơn đã qua thanh toán mới chuyển sang hàng đợi shop lấy hàng; PENDING vẫn thuộc tab thanh toán.
            .addSelect(
                `COUNT(*) FILTER (
                    WHERE order.fulfillment_status = :toShip
                      AND order.status <> :pendingStatus
                )`,
                'toShip',
            )
            .addSelect(
                'COUNT(*) FILTER (WHERE order.fulfillment_status = :shipping)',
                'shipping',
            )
            .addSelect(
                'COUNT(*) FILTER (WHERE order.fulfillment_status = :delivered)',
                'delivered',
            )
            .addSelect(
                'COUNT(*) FILTER (WHERE order.fulfillment_status = :completed)',
                'completed',
            )
            .addSelect(
                'COUNT(*) FILTER (WHERE order.fulfillment_status = :cancelled)',
                'cancelled',
            )
            .addSelect(
                'COUNT(*) FILTER (WHERE order.fulfillment_status = :returnRefund)',
                'returnRefund',
            )
            .where('order.owner_id = :ownerId', { ownerId })
            .setParameters({
                pendingStatus: OrderStatus.PENDING,
                toShip: OrderFulfillmentStatus.TO_SHIP,
                shipping: OrderFulfillmentStatus.SHIPPING,
                delivered: OrderFulfillmentStatus.DELIVERED,
                completed: OrderFulfillmentStatus.COMPLETED,
                cancelled: OrderFulfillmentStatus.CANCELLED,
                returnRefund: OrderFulfillmentStatus.RETURN_REFUND,
            })
            .getRawOne<Record<string, string>>();

        return {
            all: Number(row?.total ?? 0),
            pendingPayment: Number(row?.pendingPayment ?? 0),
            toShip: Number(row?.toShip ?? 0),
            shipping: Number(row?.shipping ?? 0),
            delivered: Number(row?.delivered ?? 0),
            completed: Number(row?.completed ?? 0),
            cancelled: Number(row?.cancelled ?? 0),
            returnRefund: Number(row?.returnRefund ?? 0),
        };
    }

    // Đếm order đã đủ điều kiện hiển thị trong Seller Center theo stage; Sandbox từng thu tiền vẫn nằm trong lịch sử shop.
    async countSellerTabs(shopId: string): Promise<SellerOrderTabCounts> {
        const [row, actionableReturnRow] = await Promise.all([
            this.repository
                .createQueryBuilder('order')
                .select('COUNT(*)', 'total')
                .addSelect(
                    'COUNT(*) FILTER (WHERE order.fulfillment_status = :toShip)',
                    'toShip',
                )
                .addSelect(
                    'COUNT(*) FILTER (WHERE order.fulfillment_status = :shipping)',
                    'shipping',
                )
                .addSelect(
                    'COUNT(*) FILTER (WHERE order.fulfillment_status = :delivered)',
                    'delivered',
                )
                .addSelect(
                    'COUNT(*) FILTER (WHERE order.fulfillment_status = :completed)',
                    'completed',
                )
                .addSelect(
                    'COUNT(*) FILTER (WHERE order.fulfillment_status = :cancelled)',
                    'cancelled',
                )
                .where(
                    `EXISTS (
            SELECT 1
            FROM order_items seller_item
            WHERE seller_item.order_id = "order"."id"
              AND seller_item.seller_shop_id = :shopId
          )`,
                    { shopId },
                )
                // Đơn đã hủy luôn giữ lịch sử kể cả khi callback tiền còn chờ; các sandbox khác cần bằng chứng đã thu/đang hoàn.
                .andWhere(
                    `(
                    order.is_sandbox = false OR order.status = 'CANCELLED' OR EXISTS (
                        SELECT 1 FROM payment_attempts paid_attempt
                        WHERE paid_attempt.order_id = "order"."id"
                          AND paid_attempt.status IN (:...sellerVisiblePaymentStatuses)
                    )
                )`,
                    {
                        sellerVisiblePaymentStatuses:
                            SELLER_VISIBLE_SANDBOX_PAYMENT_STATUSES,
                    },
                )
                // Seller chỉ nhận đơn đã thanh toán hoặc COD đã xác nhận; PENDING chưa thể xử lý giao hàng.
                .andWhere('order.status <> :pendingOrderStatus', {
                    pendingOrderStatus: OrderStatus.PENDING,
                })
                .setParameters({
                    toShip: OrderFulfillmentStatus.TO_SHIP,
                    shipping: OrderFulfillmentStatus.SHIPPING,
                    delivered: OrderFulfillmentStatus.DELIVERED,
                    completed: OrderFulfillmentStatus.COMPLETED,
                    cancelled: OrderFulfillmentStatus.CANCELLED,
                })
                .getRawOne<Record<string, string>>(),
            this.returnRepository
                .createQueryBuilder('return_request')
                .select('COUNT(*)', 'count')
                .where('return_request.shop_id = :shopId', { shopId })
                .andWhere('return_request.status IN (:...actionableStatuses)', {
                    actionableStatuses: [
                        OrderReturnStatus.REQUESTED,
                        OrderReturnStatus.RECEIVED,
                    ],
                })
                .getRawOne<{ count: string }>(),
        ]);

        return {
            all: Number(row?.total ?? 0),
            toShip: Number(row?.toShip ?? 0),
            shipping: Number(row?.shipping ?? 0),
            delivered: Number(row?.delivered ?? 0),
            completed: Number(row?.completed ?? 0),
            cancelled: Number(row?.cancelled ?? 0),
            returnRefund: Number(actionableReturnRow?.count ?? 0),
        };
    }

    // Lấy danh sách order có item thuộc shop bằng truy vấn hai bước để pagination không bị nhân bản bởi quan hệ 1-n.
    async findSellerPage(
        shopId: string,
        page: number,
        pageSize: number,
        query: SellerOrderListQueryDto,
    ): Promise<[Order[], number]> {
        const filterQuery = this.createSellerFilterQuery(shopId, query);
        const [rows, total] = await Promise.all([
            filterQuery
                .clone()
                .select('order.id', 'id')
                .orderBy('order.created_at', 'DESC')
                .addOrderBy('order.id', 'DESC')
                .skip((page - 1) * pageSize)
                .take(pageSize)
                .getRawMany<{ id: string }>(),
            filterQuery.clone().getCount(),
        ]);

        const orderIds = rows.map((row) => row.id);
        if (orderIds.length === 0) return [[], total];

        const orders = await this.repository
            .createQueryBuilder('order')
            .leftJoinAndSelect(
                'order.items',
                'item',
                'item.seller_shop_id = :shopId',
                { shopId },
            )
            .where('order.id IN (:...orderIds)', { orderIds })
            // Truy vấn hydration chạy riêng sau pagination nên phải giữ lại cùng rule Sandbox của lượt chọn ID.
            .andWhere(
                `(
                order.is_sandbox = false OR order.status = 'CANCELLED' OR EXISTS (
                    SELECT 1 FROM payment_attempts paid_attempt
                    WHERE paid_attempt.order_id = "order"."id"
                      AND paid_attempt.status IN (:...sellerVisiblePaymentStatuses)
                )
            )`,
                {
                    sellerVisiblePaymentStatuses:
                        SELLER_VISIBLE_SANDBOX_PAYMENT_STATUSES,
                },
            )
            .andWhere('order.status <> :pendingOrderStatus', {
                pendingOrderStatus: OrderStatus.PENDING,
            })
            .getMany();
        const orderById = new Map(orders.map((order) => [order.id, order]));
        return [
            orderIds
                .map((orderId) => orderById.get(orderId))
                .filter((order): order is Order => Boolean(order)),
            total,
        ];
    }

    // Chỉ trả detail khi order có item của shop hiện tại; join có điều kiện ngăn dữ liệu shop khác lọt vào response.
    findSellerById(shopId: string, orderId: string): Promise<Order | null> {
        return (
            this.repository
                .createQueryBuilder('order')
                .leftJoinAndSelect(
                    'order.items',
                    'item',
                    'item.seller_shop_id = :shopId',
                    { shopId },
                )
                .leftJoinAndSelect('order.statusHistory', 'statusHistory')
                .where('order.id = :orderId', { orderId })
                // Đơn Sandbox đã chuyển sang nhánh hoàn vẫn phải đọc được trong lịch sử sau khi hủy.
                .andWhere(
                    `(
                order.is_sandbox = false OR order.status = 'CANCELLED' OR EXISTS (
                    SELECT 1 FROM payment_attempts paid_attempt
                    WHERE paid_attempt.order_id = "order"."id"
                      AND paid_attempt.status IN (:...sellerVisiblePaymentStatuses)
                )
            )`,
                    {
                        sellerVisiblePaymentStatuses:
                            SELLER_VISIBLE_SANDBOX_PAYMENT_STATUSES,
                    },
                )
                .andWhere('order.status <> :pendingOrderStatus', {
                    pendingOrderStatus: OrderStatus.PENDING,
                })
                .andWhere(
                    `EXISTS (
          SELECT 1
          FROM order_items seller_item
          WHERE seller_item.order_id = "order"."id"
            AND seller_item.seller_shop_id = :shopId
        )`,
                    { shopId },
                )
                .getOne()
        );
    }

    // Repository transaction được lấy từ DataSource ở command service để order và item commit cùng nhau.
    getEntityRepository(): Repository<Order> {
        return this.repository;
    }

    // Tìm order item cho Product Service kiểm tra purchase proof mà không tạo foreign key hoặc truy cập database cross-service.
    findReviewContextByItemId(orderItemId: string): Promise<Order | null> {
        return this.repository
            .createQueryBuilder('order')
            .innerJoinAndSelect(
                'order.items',
                'item',
                'item.id = :orderItemId',
                { orderItemId },
            )
            .where('order.id = item.order_id')
            .getOne();
    }

    // Tổng hợp số lượng bán theo từng item; sale Sandbox đã xác nhận được tính như giao dịch LIVE.
    // Order RETURN_REFUND vẫn giữ các item không hoàn để không làm mất lượt bán của sản phẩm khác trong cùng đơn.
    // Chỉ item đã đi vào quy trình hoàn mới bị loại; request bị từ chối hoặc customer tự hủy vẫn được tính như một sale.
    async findSoldQuantities(
        sellerOwnerId: string,
        productIds: string[],
    ): Promise<Array<{ productId: string; quantitySold: number }>> {
        if (!sellerOwnerId || productIds.length === 0) return [];

        const rows = await this.repository
            .createQueryBuilder('saleOrder')
            .innerJoin(OrderItem, 'item', 'item.order_id = saleOrder.id')
            .select('item.product_id', 'productId')
            .addSelect(
                `COALESCE(
          SUM(item.quantity) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM order_return_requests return_request
              WHERE return_request.order_id = "saleOrder"."id"
                AND return_request.status IN (:...returnStatusesExcludedFromSales)
                AND return_request.item_ids @> jsonb_build_array(item.id::text)
            )
          ),
          0
        )`,
                'quantitySold',
            )
            .where('item.seller_owner_id = :sellerOwnerId', { sellerOwnerId })
            .andWhere('item.product_id IN (:...productIds)', { productIds })
            .andWhere('saleOrder.status = :confirmedStatus', {
                confirmedStatus: OrderStatus.CONFIRMED,
            })
            .andWhere('saleOrder.fulfillment_status IN (:...saleStatuses)', {
                saleStatuses: [
                    OrderFulfillmentStatus.COMPLETED,
                    OrderFulfillmentStatus.RETURN_REFUND,
                ],
            })
            .setParameter(
                'returnStatusesExcludedFromSales',
                RETURN_STATUSES_EXCLUDED_FROM_SALES,
            )
            .groupBy('item.product_id')
            .getRawMany<{ productId: string; quantitySold: string }>();

        return rows.map((row) => ({
            productId: row.productId,
            quantitySold: Number(row.quantitySold),
        }));
    }

    // Lấy các order đã quá deadline để worker xử lý từng order trong transaction có khóa pessimistic.
    findExpiredDeliveryConfirmations(now: Date, limit = 50): Promise<Order[]> {
        return this.repository
            .createQueryBuilder('order')
            .where('order.fulfillment_status = :stage', {
                stage: OrderFulfillmentStatus.DELIVERED,
            })
            .andWhere(
                'order.delivery_confirmation_status = :confirmationStatus',
                { confirmationStatus: 'PENDING' },
            )
            .andWhere('order.delivery_confirmation_deadline <= :now', { now })
            .andWhere(
                `NOT EXISTS (
        SELECT 1 FROM order_delivery_issues issue
        WHERE issue.order_id = "order"."id" AND issue.status = 'OPEN'
      )`,
            )
            .orderBy('order.delivery_confirmation_deadline', 'ASC')
            .take(limit)
            .getMany();
    }

    // Tập trung điều kiện shop/status/search để list và count dùng cùng tập dữ liệu; đơn Sandbox từng thu tiền đi đủ các stage như LIVE.
    private createSellerFilterQuery(
        shopId: string,
        query: SellerOrderListQueryDto,
    ) {
        const filterQuery = this.repository.createQueryBuilder('order').where(
            `EXISTS (
          SELECT 1
          FROM order_items seller_item
          WHERE seller_item.order_id = "order"."id"
            AND seller_item.seller_shop_id = :shopId
        )`,
            { shopId },
        );
        // Đơn đã hủy luôn hiện dù callback còn chờ; sandbox chưa hủy chỉ hiện khi Pay2S đã thu hoặc đang xử lý hoàn.
        filterQuery.andWhere(
            `(
                order.is_sandbox = false OR order.status = 'CANCELLED' OR EXISTS (
                    SELECT 1 FROM payment_attempts paid_attempt
                    WHERE paid_attempt.order_id = "order"."id"
                      AND paid_attempt.status IN (:...sellerVisiblePaymentStatuses)
                )
            )`,
            {
                sellerVisiblePaymentStatuses:
                    SELLER_VISIBLE_SANDBOX_PAYMENT_STATUSES,
            },
        );
        // Không đưa đơn đang chờ tiền vào danh sách thao tác của seller, kể cả môi trường LIVE.
        filterQuery.andWhere('order.status <> :pendingOrderStatus', {
            pendingOrderStatus: OrderStatus.PENDING,
        });

        if (query.status) {
            filterQuery.andWhere('order.status = :status', {
                status: query.status,
            });
        }

        if (query.stage) {
            filterQuery.andWhere('order.fulfillment_status = :stage', {
                stage: query.stage,
            });
        }

        const search = this.escapeLike(query.search?.trim() ?? '');
        if (search) {
            filterQuery.andWhere('order.order_number ILIKE :search', {
                search: `%${search}%`,
            });
        }

        return filterQuery;
    }

    // Escape wildcard của PostgreSQL để ô tìm mã đơn không biến thành truy vấn tùy ý.
    private escapeLike(value: string): string {
        return value.replace(/[\\%_]/g, '\\$&');
    }
}
