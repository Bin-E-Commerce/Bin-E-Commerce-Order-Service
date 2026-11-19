// Kiểm tra đơn chưa thanh toán chỉ nằm ở tab thanh toán, không lọt sang nhóm TO_SHIP.

import { FindOperator } from 'typeorm';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderRepository } from './order.repository';

describe('OrderRepository', () => {
    let target: OrderRepository;

    // Tạo SUT mới mỗi test để query và mock không rò trạng thái giữa các ca.
    beforeEach(() => {
        target = new OrderRepository(
            {} as Repository<Order>,
            {} as Repository<OrderReturnRequest>,
        );
    });

    // Customer stage filter phải loại PENDING để một order không nằm đồng thời ở hai tab.
    it('should exclude unpaid orders from the customer to-ship page', async () => {
        // Arrange
        const findAndCount = jest.fn().mockResolvedValue([[], 0]);
        const repository = {
            findAndCount,
        } as unknown as Repository<Order>;
        target = new OrderRepository(
            repository,
            {} as Repository<OrderReturnRequest>,
        );

        // Act
        await target.findOwnedPage(
            'customer-1',
            1,
            20,
            undefined,
            OrderFulfillmentStatus.TO_SHIP,
        );

        // Assert
        const query = findAndCount.mock.calls[0][0];
        expect(query.where.ownerId).toBe('customer-1');
        expect(query.where.fulfillmentStatus).toBe(
            OrderFulfillmentStatus.TO_SHIP,
        );
        expect(query.where.status).toBeInstanceOf(FindOperator);
        expect(query.where.status.value).toBe(OrderStatus.PENDING);
    });

    // Badge count phải dùng cùng ranh giới trạng thái với trang TO_SHIP.
    it('should exclude pending payment from the customer to-ship count', async () => {
        // Arrange
        const queryBuilder = {
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            setParameters: jest.fn().mockReturnThis(),
            getRawOne: jest.fn().mockResolvedValue({
                total: '2',
                pendingPayment: '1',
                toShip: '1',
                shipping: '0',
                delivered: '0',
                completed: '0',
                cancelled: '0',
                returnRefund: '0',
            }),
        } as unknown as SelectQueryBuilder<Order>;
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as Repository<Order>;
        target = new OrderRepository(
            repository,
            {} as Repository<OrderReturnRequest>,
        );

        // Act
        const result = await target.countOwnedTabs('customer-1');

        // Assert
        const toShipExpression = (
            queryBuilder.addSelect as jest.Mock
        ).mock.calls.find((call) => call[1] === 'toShip')?.[0] as string;
        expect(toShipExpression).toContain('order.status <> :pendingStatus');
        expect(result).toEqual({
            all: 2,
            pendingPayment: 1,
            toShip: 1,
            shipping: 0,
            delivered: 0,
            completed: 0,
            cancelled: 0,
            returnRefund: 0,
        });
    });

    // Yêu cầu hoàn bị từ chối vẫn thuộc lịch sử hoàn của shop và không quay lại tab Hoàn thành.
    it('should filter seller return history independently of fulfillment status', () => {
        const queryBuilder = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
        };
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as Repository<Order>;
        target = new OrderRepository(
            repository,
            {} as Repository<OrderReturnRequest>,
        );

        const createFilter = Reflect.get(target, 'createSellerFilterQuery') as (
            shopId: string,
            query: { stage: OrderFulfillmentStatus },
        ) => unknown;
        createFilter.call(target, 'shop-1', {
            stage: OrderFulfillmentStatus.RETURN_REFUND,
        });
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('seller_return.shop_id = :shopId'),
        );

        queryBuilder.andWhere.mockClear();
        createFilter.call(target, 'shop-1', {
            stage: OrderFulfillmentStatus.COMPLETED,
        });
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('NOT EXISTS'),
        );
    });

    // Badge tab hoàn đếm order đã có yêu cầu bất kể trạng thái duyệt, đúng cùng tập với danh sách.
    it('should count seller return orders from the scoped order query', async () => {
        const queryBuilder = {
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            setParameters: jest.fn().mockReturnThis(),
            getRawOne: jest.fn().mockResolvedValue({
                total: '2',
                completed: '1',
                returnRefund: '1',
            }),
        };
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as Repository<Order>;
        target = new OrderRepository(
            repository,
            {} as Repository<OrderReturnRequest>,
        );

        const counts = await target.countSellerTabs('shop-1');
        expect(counts.returnRefund).toBe(1);
        expect(counts.completed).toBe(1);
        expect(
            queryBuilder.addSelect.mock.calls.find(
                (call) => call[1] === 'returnRefund',
            )?.[0],
        ).toContain('seller_return.shop_id = :shopId');
    });
});
