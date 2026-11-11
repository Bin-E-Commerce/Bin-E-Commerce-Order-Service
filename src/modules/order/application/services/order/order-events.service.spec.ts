// Unit test bảo vệ purchase event dùng đúng snapshot category/brand đã lưu trong order item.

import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { OrderPurchaseEventOutboxEntity } from '@/database/integration/entities/order-purchase-event-outbox.entity';
import { Order } from '@/database/order/entities/order.entity';
import { KafkaProducerService } from '@/kafka/kafka-producer.service';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';

// Kiểm tra outbox payload ở public method để không khóa test vào private mapper.
describe('OrderEventsService purchase snapshot', () => {
    let target: OrderEventsService;
    let mockKafkaProducer: DeepMocked<KafkaProducerService>;
    let mockDataSource: DeepMocked<DataSource>;
    let mockOrderRepository: DeepMocked<Repository<Order>>;
    let mockPurchaseOutboxRepository: DeepMocked<
        Repository<OrderPurchaseEventOutboxEntity>
    >;

    // Dựng service bằng repository mock để test transaction boundary mà không gọi Kafka hoặc PostgreSQL thật.
    beforeEach(() => {
        mockKafkaProducer = createMock<KafkaProducerService>();
        mockDataSource = createMock<DataSource>();
        mockOrderRepository = createMock<Repository<Order>>();
        mockPurchaseOutboxRepository =
            createMock<Repository<OrderPurchaseEventOutboxEntity>>();
        target = new OrderEventsService(
            mockKafkaProducer,
            mockDataSource,
            mockOrderRepository,
            mockPurchaseOutboxRepository,
        );
    });

    // Order item snapshot là nguồn cho event; brand phải đi cùng category và quantity sang outbox.
    it('should include the saved brand snapshot in purchase event payload', async () => {
        // Arrange
        const item = {
            id: 'order-item-1',
            productId: 'product-1',
            variantId: 'variant-1',
            categoryId: 'category-1',
            brandId: 'brand-1',
            quantity: 2,
        };
        const order = {
            id: 'order-1',
            ownerId: 'user-1',
            completedAt: new Date('2026-11-01T00:00:00.000Z'),
            items: [item],
        } as Order;
        const queryBuilder = {
            insert: jest.fn().mockReturnThis(),
            into: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            orIgnore: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
        };
        const outboxRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };
        const manager = {
            getRepository: jest.fn((entity: unknown) =>
                entity === Order ? orderRepository : outboxRepository,
            ),
        };
        // Thu hẹp overload Jest mock để callback nhận đúng EntityManager giả trong transaction.
        const transactionMock =
            mockDataSource.transaction as unknown as jest.Mock<
                Promise<unknown>,
                [(entityManager: EntityManager) => Promise<unknown>]
            >;
        transactionMock.mockImplementation(async (callback) =>
            callback(manager as unknown as EntityManager),
        );

        // Act
        await target.enqueuePurchaseCompleted('order-1');

        // Assert
        expect(queryBuilder.values).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: 'order.purchase.completed:order-1',
                payload: expect.objectContaining({
                    data: expect.objectContaining({
                        items: [
                            expect.objectContaining({
                                orderItemId: 'order-item-1',
                                productId: 'product-1',
                                categoryId: 'category-1',
                                brandId: 'brand-1',
                                quantity: 2,
                            }),
                        ],
                    }),
                }),
            }),
        );
        expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
        expect(mockKafkaProducer.publish).not.toHaveBeenCalled();
    });
});
