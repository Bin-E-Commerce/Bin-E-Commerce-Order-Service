// Read model dashboard của Order Service, chịu trách nhiệm duy nhất cho số liệu order theo shop.
// Service này không nhận owner tùy ý từ browser; chỉ được gọi qua internal token và shop scope đã xác định.

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import type {
    SellerDashboardLatestOrder,
    SellerDashboardOrderSnapshot,
    SellerDashboardOrderStatusCounts,
    SellerDashboardOrderSummary,
    SellerDashboardRevenuePoint,
    SellerDashboardTopProduct,
} from '@/modules/order/application/types/seller-dashboard-order.type';

// Chỉ loại item đã thực sự đi vào quy trình hoàn; request bị từ chối hoặc customer tự hủy vẫn là sale hợp lệ.
const RETURN_STATUSES_EXCLUDED_FROM_SALES = [
    OrderReturnStatus.AWAITING_SHIPMENT,
    OrderReturnStatus.IN_TRANSIT,
    OrderReturnStatus.SHIPMENT_FAILED,
    OrderReturnStatus.RECEIVED,
    OrderReturnStatus.INSPECTION_FAILED,
    OrderReturnStatus.REFUND_PENDING,
];

interface SellerDashboardDateRange {
    from: Date;
    to: Date;
}

@Injectable()
export class SellerDashboardOrderService {
    constructor(
        @InjectRepository(Order)
        private readonly orderRepository: Repository<Order>,
        @InjectRepository(OrderItem)
        private readonly orderItemRepository: Repository<OrderItem>,
        @InjectRepository(OrderReturnRequest)
        private readonly returnRepository: Repository<OrderReturnRequest>,
    ) {}

    // Tổng hợp một snapshot để Seller Service không phải gọi nhiều endpoint nhỏ.
    // Doanh thu dùng line_total của item thuộc shop, loại đơn chưa xác nhận và đơn đã hủy.
    async getSnapshot(
        shopId: string,
        currentRange: SellerDashboardDateRange,
        previousRange: SellerDashboardDateRange,
    ): Promise<SellerDashboardOrderSnapshot> {
        const [
            current,
            previous,
            revenueTrend,
            orderStatusCounts,
            pendingReturns,
            latestOrders,
            recentReturnOrders,
            topProducts,
        ] = await Promise.all([
            this.getSummary(shopId, currentRange),
            this.getSummary(shopId, previousRange),
            this.getRevenueTrend(shopId, currentRange),
            this.getOrderStatusCounts(shopId),
            this.getPendingReturns(shopId),
            this.getLatestOrders(shopId),
            this.getLatestOrders(
                shopId,
                OrderFulfillmentStatus.RETURN_REFUND,
            ),
            this.getTopProducts(shopId, currentRange),
        ]);

        return {
            current,
            previous,
            revenueTrend,
            orderStatusCounts,
            pendingReturns,
            latestOrders,
            recentReturnOrders,
            topProducts,
        };
    }

    // Chỉ những order CONFIRMED và chưa bị hủy mới được tính là doanh thu gộp hợp lệ.
    private async getSummary(
        shopId: string,
        range: SellerDashboardDateRange,
    ): Promise<SellerDashboardOrderSummary> {
        const row = await this.orderItemRepository
            .createQueryBuilder('item')
            .innerJoin(Order, 'ord', 'ord.id = item.order_id')
            .select('COALESCE(SUM(item.line_total), 0)', 'grossRevenue')
            .addSelect('COUNT(DISTINCT ord.id)', 'orderCount')
            .where('item.seller_shop_id = :shopId', { shopId })
            .andWhere('ord.status = :confirmedStatus', {
                confirmedStatus: OrderStatus.CONFIRMED,
            })
            .andWhere('ord.fulfillment_status != :cancelledStatus', {
                cancelledStatus: OrderFulfillmentStatus.CANCELLED,
            })
            .andWhere(
                `NOT EXISTS (
                    SELECT 1 FROM order_return_requests return_request
                    WHERE return_request.order_id = ord.id
                      AND return_request.status IN (:...returnStatusesExcludedFromSales)
                      AND return_request.item_ids @> jsonb_build_array(item.id::text)
                )`,
            )
            .andWhere('ord.created_at >= :from', { from: range.from })
            .andWhere('ord.created_at < :to', { to: range.to })
            .setParameter(
                'returnStatusesExcludedFromSales',
                RETURN_STATUSES_EXCLUDED_FROM_SALES,
            )
            .getRawOne<{ grossRevenue: string; orderCount: string }>();

        return {
            grossRevenue: Number(row?.grossRevenue ?? 0),
            orderCount: Number(row?.orderCount ?? 0),
        };
    }

    // Group ngày theo Asia/Ho_Chi_Minh để biểu đồ không bị lệch ngày khi database lưu UTC.
    private async getRevenueTrend(
        shopId: string,
        range: SellerDashboardDateRange,
    ): Promise<SellerDashboardRevenuePoint[]> {
        const rows = await this.orderItemRepository
            .createQueryBuilder('item')
            .innerJoin(Order, 'ord', 'ord.id = item.order_id')
            .select(
                "TO_CHAR(DATE_TRUNC('day', ord.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD')",
                'date',
            )
            .addSelect('COALESCE(SUM(item.line_total), 0)', 'grossRevenue')
            .addSelect('COUNT(DISTINCT ord.id)', 'orderCount')
            .where('item.seller_shop_id = :shopId', { shopId })
            .andWhere('ord.status = :confirmedStatus', {
                confirmedStatus: OrderStatus.CONFIRMED,
            })
            .andWhere('ord.fulfillment_status != :cancelledStatus', {
                cancelledStatus: OrderFulfillmentStatus.CANCELLED,
            })
            .andWhere(
                `NOT EXISTS (
                    SELECT 1 FROM order_return_requests return_request
                    WHERE return_request.order_id = ord.id
                      AND return_request.status IN (:...returnStatusesExcludedFromSales)
                      AND return_request.item_ids @> jsonb_build_array(item.id::text)
                )`,
            )
            .andWhere('ord.created_at >= :from', { from: range.from })
            .andWhere('ord.created_at < :to', { to: range.to })
            .setParameter(
                'returnStatusesExcludedFromSales',
                RETURN_STATUSES_EXCLUDED_FROM_SALES,
            )
            .groupBy('date')
            .orderBy('date', 'ASC')
            .getRawMany<{
                date: string;
                grossRevenue: string;
                orderCount: string;
            }>();

        return rows.map((row) => ({
            date: row.date,
            grossRevenue: Number(row.grossRevenue),
            orderCount: Number(row.orderCount),
        }));
    }

    // Đếm trạng thái toàn shop để phần Việc cần xử lý luôn phản ánh queue hiện tại.
    private async getOrderStatusCounts(
        shopId: string,
    ): Promise<SellerDashboardOrderStatusCounts> {
        const row = await this.orderRepository
            .createQueryBuilder('ord')
            .select('COUNT(DISTINCT ord.id)', 'all')
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.status = :pendingConfirmation)',
                'pendingConfirmation',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :pendingShipment)',
                'pendingShipment',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :shipping)',
                'shipping',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :delivered)',
                'delivered',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :completed)',
                'completed',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :cancelled)',
                'cancelled',
            )
            .addSelect(
                'COUNT(DISTINCT ord.id) FILTER (WHERE ord.fulfillment_status = :returnRefund)',
                'returnRefund',
            )
            .where(
                `EXISTS (
                    SELECT 1 FROM order_items seller_item
                    WHERE seller_item.order_id = ord.id
                      AND seller_item.seller_shop_id = :shopId
                )`,
                { shopId },
            )
            .setParameters({
                pendingConfirmation: OrderStatus.PENDING,
                pendingShipment: OrderFulfillmentStatus.TO_SHIP,
                shipping: OrderFulfillmentStatus.SHIPPING,
                delivered: OrderFulfillmentStatus.DELIVERED,
                completed: OrderFulfillmentStatus.COMPLETED,
                cancelled: OrderFulfillmentStatus.CANCELLED,
                returnRefund: OrderFulfillmentStatus.RETURN_REFUND,
            })
            .getRawOne<Record<string, string>>();

        return {
            all: Number(row?.all ?? 0),
            pendingConfirmation: Number(row?.pendingConfirmation ?? 0),
            pendingShipment: Number(row?.pendingShipment ?? 0),
            shipping: Number(row?.shipping ?? 0),
            delivered: Number(row?.delivered ?? 0),
            completed: Number(row?.completed ?? 0),
            cancelled: Number(row?.cancelled ?? 0),
            returnRefund: Number(row?.returnRefund ?? 0),
        };
    }

    // Return queue dùng cùng nhóm trạng thái actionable với Seller Order API hiện có.
    private async getPendingReturns(shopId: string): Promise<number> {
        return this.returnRepository
            .createQueryBuilder('return_request')
            .where('return_request.shop_id = :shopId', { shopId })
            .andWhere('return_request.status IN (:...statuses)', {
                statuses: [
                    OrderReturnStatus.REQUESTED,
                    OrderReturnStatus.RECEIVED,
                ],
            })
            .getCount();
    }

    // Lấy tối đa năm đơn theo shop; truy vấn riêng RETURN_REFUND giúp đơn hoàn không bị chìm dưới đơn mới hơn.
    private async getLatestOrders(
        shopId: string,
        fulfillmentStatus?: OrderFulfillmentStatus,
    ): Promise<SellerDashboardLatestOrder[]> {
        const query = this.orderRepository
            .createQueryBuilder('ord')
            .innerJoin('ord.items', 'item', 'item.seller_shop_id = :shopId', {
                shopId,
            })
            .select('ord.id', 'id')
            .addSelect('ord.order_number', 'orderNumber')
            .addSelect('ord.status', 'status')
            .addSelect('ord.fulfillment_status', 'fulfillmentStatus')
            .addSelect('COALESCE(SUM(item.line_total), 0)', 'grossAmount')
            .addSelect('COALESCE(SUM(item.quantity), 0)', 'itemCount')
            .addSelect('COUNT(item.id)', 'itemLineCount')
            // Lý do lấy từ yêu cầu hoàn mới nhất trong cùng shop/đơn; scope shop không dựa riêng vào orderId.
            .addSelect(
                (subQuery) =>
                    subQuery
                        .select('return_request.reason')
                        .from(OrderReturnRequest, 'return_request')
                        .where('return_request.order_id = ord.id')
                        .andWhere('return_request.shop_id = :shopId')
                        .orderBy('return_request.requested_at', 'DESC')
                        .limit(1),
                'returnReason',
            )
            // Mô tả có thể rỗng theo schema; giữ null để câu trả lời không tự diễn giải thêm chi tiết.
            .addSelect(
                (subQuery) =>
                    subQuery
                        .select('return_request.description')
                        .from(OrderReturnRequest, 'return_request')
                        .where('return_request.order_id = ord.id')
                        .andWhere('return_request.shop_id = :shopId')
                        .orderBy('return_request.requested_at', 'DESC')
                        .limit(1),
                'returnDescription',
            )
            .addSelect(
                `COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'productId', item.product_id,
                            'name', item.product_name,
                            'thumbnailUrl', item.image_url,
                            'quantity', item.quantity,
                            'lineTotal', item.line_total
                        ) ORDER BY item.id
                    ),
                    '[]'::json
                )`,
                'items',
            )
            .addSelect('ord.created_at', 'createdAt')
            .groupBy('ord.id')
            .addGroupBy('ord.order_number')
            .addGroupBy('ord.status')
            .addGroupBy('ord.fulfillment_status')
            .addGroupBy('ord.created_at')
            .orderBy('ord.created_at', 'DESC');

        // Bản đọc chi tiết phải giữ item đang hoàn trả; bộ lọc loại hàng trả chỉ áp dụng phép tính doanh thu.
        if (fulfillmentStatus) {
            query.andWhere('ord.fulfillment_status = :fulfillmentStatus', {
                fulfillmentStatus,
            });
        }

        const rows = await query.limit(5).getRawMany<{
            id: string;
            orderNumber: string;
            status: OrderStatus;
            fulfillmentStatus: OrderFulfillmentStatus;
            grossAmount: string;
            itemCount: string;
            itemLineCount: string;
            returnReason: OrderReturnReason | null;
            returnDescription: string | null;
            items: Array<{
                productId: string;
                name: string;
                thumbnailUrl: string | null;
                quantity: number;
                lineTotal: string;
            }>;
            createdAt: Date;
        }>();

        return rows.map((row) => ({
            id: row.id,
            orderNumber: row.orderNumber,
            status: row.status,
            fulfillmentStatus: row.fulfillmentStatus,
            grossAmount: Number(row.grossAmount),
            itemCount: Number(row.itemCount),
            itemLineCount: Number(row.itemLineCount),
            // Chỉ công khai reason/description trên đơn đang RETURN_REFUND; lịch sử return cũ không rò vào đơn trạng thái khác.
            returnReason:
                row.fulfillmentStatus === OrderFulfillmentStatus.RETURN_REFUND
                    ? row.returnReason
                    : null,
            returnDescription:
                row.fulfillmentStatus === OrderFulfillmentStatus.RETURN_REFUND
                    ? row.returnDescription
                    : null,
            // Giới hạn ảnh/tên gửi lên dashboard và LLM; tổng số dòng vẫn cho UI biết còn mặt hàng nào bị gọn lại.
            items: row.items.slice(0, 4).map((item) => ({
                ...item,
                lineTotal: Number(item.lineTotal),
            })),
            createdAt: new Date(row.createdAt).toISOString(),
        }));
    }

    // Xếp top product theo doanh thu gộp trong kỳ đang xem, vẫn loại item hoàn hàng giống các query sales khác.
    private async getTopProducts(
        shopId: string,
        range: SellerDashboardDateRange,
    ): Promise<SellerDashboardTopProduct[]> {
        const rows = await this.orderItemRepository
            .createQueryBuilder('item')
            .innerJoin(Order, 'ord', 'ord.id = item.order_id')
            .select('item.product_id', 'productId')
            .addSelect('item.product_name', 'name')
            .addSelect('MAX(item.image_url)', 'thumbnailUrl')
            .addSelect('COALESCE(SUM(item.quantity), 0)', 'quantitySold')
            .addSelect('COALESCE(SUM(item.line_total), 0)', 'revenue')
            .where('item.seller_shop_id = :shopId', { shopId })
            .andWhere('ord.status = :confirmedStatus', {
                confirmedStatus: OrderStatus.CONFIRMED,
            })
            .andWhere('ord.fulfillment_status != :cancelledStatus', {
                cancelledStatus: OrderFulfillmentStatus.CANCELLED,
            })
            .andWhere(
                `NOT EXISTS (
                    SELECT 1 FROM order_return_requests return_request
                    WHERE return_request.order_id = ord.id
                      AND return_request.status IN (:...returnStatusesExcludedFromSales)
                      AND return_request.item_ids @> jsonb_build_array(item.id::text)
                )`,
            )
            .andWhere('ord.created_at >= :from', { from: range.from })
            .andWhere('ord.created_at < :to', { to: range.to })
            .setParameter(
                'returnStatusesExcludedFromSales',
                RETURN_STATUSES_EXCLUDED_FROM_SALES,
            )
            .groupBy('item.product_id')
            .addGroupBy('item.product_name')
            .orderBy('revenue', 'DESC')
            .limit(5)
            .getRawMany<{
                productId: string;
                name: string;
                thumbnailUrl: string | null;
                quantitySold: string;
                revenue: string;
            }>();

        return rows.map((row) => ({
            productId: row.productId,
            name: row.name,
            thumbnailUrl: row.thumbnailUrl,
            quantitySold: Number(row.quantitySold),
            revenue: Number(row.revenue),
        }));
    }
}
