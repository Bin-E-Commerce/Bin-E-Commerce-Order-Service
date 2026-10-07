// Kiểm tra hàng đợi và lý do đơn được lọc từ Order Service, không truy cập database thật.
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { SellerDashboardOrderService } from '@/modules/order/application/services/dashboard/seller-dashboard-order.service';

describe('SellerDashboardOrderService', () => {
    let target: SellerDashboardOrderService;
    let queryBuilder: {
        innerJoin: jest.Mock;
        select: jest.Mock;
        addSelect: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        groupBy: jest.Mock;
        addGroupBy: jest.Mock;
        orderBy: jest.Mock;
        addOrderBy: jest.Mock;
        setParameter: jest.Mock;
        limit: jest.Mock;
        getRawOne: jest.Mock;
        getRawMany: jest.Mock;
    };

    // Dùng fluent mock để tập trung kiểm tra query policy và map kết quả của read model.
    beforeEach(() => {
        queryBuilder = {
            innerJoin: jest.fn(),
            select: jest.fn(),
            addSelect: jest.fn(),
            where: jest.fn(),
            andWhere: jest.fn(),
            groupBy: jest.fn(),
            addGroupBy: jest.fn(),
            orderBy: jest.fn(),
            addOrderBy: jest.fn(),
            setParameter: jest.fn(),
            limit: jest.fn(),
            getRawOne: jest.fn(),
            getRawMany: jest.fn(),
        };
        Object.values(queryBuilder).forEach((method) =>
            method.mockReturnValue(queryBuilder),
        );
        queryBuilder.getRawOne.mockResolvedValue(null);
        queryBuilder.getRawMany.mockResolvedValue([]);

        const orderRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };
        target = new SellerDashboardOrderService(
            orderRepository as never,
            {
                createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
            } as never,
            {} as never,
        );
    });

    // Hàng đợi phải loại trạng thái đã hủy và chỉ nhận việc shop còn cần xử lý.
    it('excludes cancelled orders from the actionable queue and applies urgent-first ordering', async () => {
        // Arrange
        const readOrders = Reflect.get(target, 'getLatestOrders') as (
            shopId: string,
            options: { actionable: boolean; limit: number },
        ) => Promise<{ orders: unknown[]; hasMore: boolean }>;

        // Act
        await readOrders.call(target, 'shop-1', {
            actionable: true,
            limit: 20,
        });

        // Assert
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('ord.status != :cancelledOrderStatus'),
            expect.objectContaining({
                cancelledOrderStatus: OrderStatus.CANCELLED,
                cancelledFulfillmentStatus: OrderFulfillmentStatus.CANCELLED,
                actionableStatuses: expect.arrayContaining([
                    OrderFulfillmentStatus.TO_SHIP,
                    OrderFulfillmentStatus.DELIVERY_FAILED,
                    OrderFulfillmentStatus.RETURN_REFUND,
                ]),
            }),
        );
        expect(queryBuilder.orderBy).toHaveBeenCalledWith(
            expect.stringContaining('urgentStatuses'),
            'ASC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
            'ord.created_at',
            'ASC',
        );
    });

    // Đơn hủy chỉ trả cancelReason của trạng thái CANCELLED và đánh dấu khi trang giới hạn còn đơn khác.
    it('keeps cancellation reasons status-scoped and reports truncated pages', async () => {
        // Arrange
        queryBuilder.getRawMany.mockResolvedValue([
            {
                id: 'cancelled-1',
                orderNumber: 'BIN-CANCELLED-1',
                status: OrderStatus.CANCELLED,
                fulfillmentStatus: OrderFulfillmentStatus.CANCELLED,
                grossAmount: '120000',
                itemCount: '1',
                itemLineCount: '1',
                returnReason: null,
                returnDescription: null,
                cancelReason: '  Khách đổi ý  ',
                items: [],
                createdAt: new Date('2026-09-19T03:00:00.000Z'),
            },
            {
                id: 'cancelled-2',
                orderNumber: 'BIN-CANCELLED-2',
                status: OrderStatus.CANCELLED,
                fulfillmentStatus: OrderFulfillmentStatus.CANCELLED,
                grossAmount: '80000',
                itemCount: '1',
                itemLineCount: '1',
                returnReason: null,
                returnDescription: null,
                cancelReason: null,
                items: [],
                createdAt: new Date('2026-09-18T03:00:00.000Z'),
            },
        ]);
        const readOrders = Reflect.get(target, 'getLatestOrders') as (
            shopId: string,
            options: { orderStatus: OrderStatus; limit: number },
        ) => Promise<{
            orders: Array<{ cancelReason: string | null }>;
            hasMore: boolean;
        }>;

        // Act
        const page = await readOrders.call(target, 'shop-1', {
            orderStatus: OrderStatus.CANCELLED,
            limit: 1,
        });

        // Assert
        expect(page).toEqual({
            orders: [expect.objectContaining({ cancelReason: 'Khách đổi ý' })],
            hasMore: true,
        });
        expect(queryBuilder.limit).toHaveBeenCalledWith(2);
    });

    // “Đã giao cho khách” gồm đơn đang ở DELIVERED và đơn đã chuyển tiếp sang COMPLETED.
    it('includes both delivered and completed orders in the delivered-order list', async () => {
        // Arrange
        const readOrders = Reflect.get(target, 'getLatestOrders') as (
            shopId: string,
            options: {
                fulfillmentStatuses: OrderFulfillmentStatus[];
                limit: number;
            },
        ) => Promise<unknown>;
        const fulfillmentStatuses = [
            OrderFulfillmentStatus.DELIVERED,
            OrderFulfillmentStatus.COMPLETED,
        ];

        // Act
        await readOrders.call(target, 'shop-1', {
            fulfillmentStatuses,
            limit: 20,
        });

        // Assert
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'ord.fulfillment_status IN (:...fulfillmentStatuses)',
            { fulfillmentStatuses },
        );
        expect(queryBuilder.limit).toHaveBeenCalledWith(21);
    });

    // Doanh số theo sản phẩm chỉ phản ánh giao dịch đã hoàn tất, không tính đơn còn đang vận chuyển.
    it('filters product revenue to completed fulfillment only', async () => {
        // Arrange
        const readTopProducts = Reflect.get(target, 'getTopProducts') as (
            shopId: string,
            range: { from: Date; to: Date },
        ) => Promise<unknown>;

        // Act
        await readTopProducts.call(target, 'shop-1', {
            from: new Date('2026-09-01T00:00:00.000Z'),
            to: new Date('2026-10-01T00:00:00.000Z'),
        });

        // Assert
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'ord.fulfillment_status = :completedStatus',
            { completedStatus: OrderFulfillmentStatus.COMPLETED },
        );
        expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
            'ord.fulfillment_status != :cancelledStatus',
            expect.anything(),
        );
    });

    // KPI và biểu đồ phải cùng loại đơn; nếu lệch điều kiện, tổng trên chart không khớp con số doanh thu.
    it('filters revenue summary and daily trend to completed orders only', async () => {
        // Arrange
        const range = {
            from: new Date('2026-09-01T00:00:00.000Z'),
            to: new Date('2026-10-01T00:00:00.000Z'),
        };
        const readSummary = Reflect.get(target, 'getSummary') as (
            shopId: string,
            dateRange: typeof range,
        ) => Promise<unknown>;
        const readRevenueTrend = Reflect.get(target, 'getRevenueTrend') as (
            shopId: string,
            dateRange: typeof range,
        ) => Promise<unknown>;

        // Kiểm tra riêng từng query để tránh một nhánh che điều kiện thiếu ở nhánh còn lại.
        await readSummary.call(target, 'shop-1', range);
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'ord.fulfillment_status = :completedStatus',
            { completedStatus: OrderFulfillmentStatus.COMPLETED },
        );

        queryBuilder.andWhere.mockClear();
        await readRevenueTrend.call(target, 'shop-1', range);
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'ord.fulfillment_status = :completedStatus',
            { completedStatus: OrderFulfillmentStatus.COMPLETED },
        );
        expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
            'ord.fulfillment_status != :cancelledStatus',
            expect.anything(),
        );
    });
});
