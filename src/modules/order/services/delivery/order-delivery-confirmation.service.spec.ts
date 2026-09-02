// Unit test cho vòng đời DELIVERED → customer xác nhận hoặc auto-complete của Order Service.
// Transaction manager được mô phỏng để kiểm tra locking và business rule mà không cần PostgreSQL thật.
/// <reference types="jest" />
import { Test, type TestingModule } from "@nestjs/testing";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { DataSource } from "typeorm";
import { Order } from "../../../../database/order/entities/order.entity";
import { OrderItem } from "../../../../database/order/entities/order-item.entity";
import { OrderStatus } from "../../../../database/order/enums/order-status.enum";
import { OrderDeliveryIssue } from "../../../../database/delivery/entities/order-delivery-issue.entity";
import { OrderDeliveryConfirmationStatus } from "../../../../database/delivery/enums/order-delivery-confirmation-status.enum";
import { OrderFulfillmentStatus } from "../../../../database/order/enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../../../../database/order/enums/payment-status.enum";
import {
  DeliveryConfirmationDecision,
  type DeliveryConfirmationDto,
} from "../../dto/delivery-confirmation.dto";
import { OrderRepository } from "../../repositories/order.repository";
import { OrderEventsService } from "../order/order-events.service";
import { OrderResponseMapper } from "../order/order-response-mapper.service";
import { OrderDeliveryConfirmationService } from "./order-delivery-confirmation.service";

describe("OrderDeliveryConfirmationService", () => {
  let target: OrderDeliveryConfirmationService;
  let mockOrderRepository: DeepMocked<OrderRepository>;
  let mockResponseMapper: DeepMocked<OrderResponseMapper>;
  let mockOrderEvents: DeepMocked<OrderEventsService>;
  let mockDataSource: DeepMocked<DataSource>;

  const ownerId = "11111111-1111-4111-8111-111111111111";
  const orderId = "22222222-2222-4222-8222-222222222222";

  // Tạo order đang chờ customer xác nhận để test các nhánh chuyển trạng thái.
  const createDeliveredOrder = (): Order =>
    ({
      id: orderId,
      ownerId,
      status: OrderStatus.CONFIRMED,
      fulfillmentStatus: OrderFulfillmentStatus.DELIVERED,
      deliveryConfirmationStatus: OrderDeliveryConfirmationStatus.PENDING,
      deliveryConfirmationDeadline: new Date("2026-09-03T10:00:00.000Z"),
      deliveredAt: new Date("2026-08-31T10:00:00.000Z"),
      items: [],
    }) as unknown as Order;

  // Tạo query builder tối giản có cùng API mà service sử dụng với pessimistic lock.
  const createQueryBuilder = (order: Order | null) => {
    const builder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
    };
    return builder;
  };

  // Gắn transaction mock vào DataSource để callback luôn chạy trong manager giả lập.
  const mockTransaction = (order: Order | null) => {
    const orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(order)),
      save: jest.fn().mockImplementation(async (value: Order) => value),
    };
    const itemRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    const issueRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: unknown) => value),
      save: jest.fn().mockImplementation(async (value: unknown) => value),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === OrderItem
          ? itemRepository
          : entity === OrderDeliveryIssue
            ? issueRepository
            : orderRepository,
      ),
    };
    mockDataSource.transaction.mockImplementation(async (callback: any) => callback(manager));
    return orderRepository;
  };

  // Khởi tạo TestingModule với toàn bộ dependency của delivery use case.
  beforeEach(async () => {
    mockOrderRepository = createMock<OrderRepository>();
    mockResponseMapper = createMock<OrderResponseMapper>();
    mockOrderEvents = createMock<OrderEventsService>();
    mockDataSource = createMock<DataSource>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderDeliveryConfirmationService,
        { provide: OrderRepository, useValue: mockOrderRepository },
        { provide: OrderResponseMapper, useValue: mockResponseMapper },
        { provide: OrderEventsService, useValue: mockOrderEvents },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();
    target = module.get<OrderDeliveryConfirmationService>(OrderDeliveryConfirmationService);
  });

  // Ghi nhận delivered chỉ một lần và phát event nhắc customer xác nhận.
  it("should mark an order as delivered and open confirmation window", async () => {
    // Arrange
    const order = {
      ...createDeliveredOrder(),
      fulfillmentStatus: OrderFulfillmentStatus.SHIPPING,
      deliveryConfirmationStatus: OrderDeliveryConfirmationStatus.PENDING,
    } as Order;
    mockTransaction(order);

    // Act
    await target.markDelivered(orderId, "2026-08-31T10:00:00.000Z");

    // Assert
    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.DELIVERED);
    expect(order.deliveryConfirmationDeadline).toEqual(new Date("2026-09-03T10:00:00.000Z"));
    expect(mockOrderEvents.publishDeliveryAwaitingConfirmation).toHaveBeenCalledWith(orderId);
  });

  // Đồng bộ mốc đang giao từ Shipping và không cho event cũ làm trạng thái đơn quay ngược.
  it("should sync shipment stages monotonically", async () => {
    // Arrange
    const order = {
      ...createDeliveredOrder(),
      fulfillmentStatus: OrderFulfillmentStatus.TO_SHIP,
      deliveryConfirmationStatus: OrderDeliveryConfirmationStatus.PENDING,
    } as Order;
    mockTransaction(order);

    // Act
    await target.syncShipmentStatus(orderId, "IN_TRANSIT", "2026-08-31T10:00:00.000Z");
    await target.syncShipmentStatus(orderId, "READY_TO_SHIP", "2026-08-31T09:00:00.000Z");

    // Assert
    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.SHIPPING);
  });

  // Shipper đã lấy kiện thì customer phải thấy đơn ở nhóm đang giao, không còn ở nhóm chờ lấy hàng.
  it("should move the order to shipping when the carrier picks it up", async () => {
    const order = {
      ...createDeliveredOrder(),
      fulfillmentStatus: OrderFulfillmentStatus.TO_SHIP,
      deliveryConfirmationStatus: OrderDeliveryConfirmationStatus.PENDING,
    } as Order;
    mockTransaction(order);

    await target.syncShipmentStatus(orderId, "PICKED_UP", "2026-08-31T10:00:00.000Z");

    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.SHIPPING);
  });

  // Customer nhận hàng thì hoàn tất order ngay và ghi nhận payment COD đã thu.
  it("should complete an order when customer confirms receipt", async () => {
    // Arrange
    const order = createDeliveredOrder();
    mockTransaction(order);
    mockOrderRepository.findOwnedById.mockResolvedValue(order);
    mockResponseMapper.toResponse.mockReturnValue({ id: orderId } as never);
    const dto: DeliveryConfirmationDto = { decision: DeliveryConfirmationDecision.RECEIVED };

    // Act
    const result = await target.confirm(ownerId, orderId, dto);

    // Assert
    expect(result).toEqual({ id: orderId });
    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.COMPLETED);
    expect(order.paymentStatus).toBe(PaymentStatus.PAID);
    expect(order.deliveryConfirmationStatus).toBe(OrderDeliveryConfirmationStatus.CONFIRMED);
    expect(mockOrderEvents.publishDeliveryConfirmed).toHaveBeenCalledWith(orderId);
  });

  // Customer báo issue thì order phải rời tab Chờ xác nhận sang Trả hàng/Hoàn tiền, nhưng issue vẫn mở cho Seller xử lý.
  it("should move an order to return/refund when customer reports a delivery issue", async () => {
    const order = createDeliveredOrder();
    mockTransaction(order);
    mockOrderRepository.findOwnedById.mockResolvedValue(order);
    mockResponseMapper.toResponse.mockReturnValue({ id: orderId } as never);

    await target.confirm(ownerId, orderId, {
      decision: DeliveryConfirmationDecision.ISSUE,
      reason: "NOT_RECEIVED" as DeliveryConfirmationDto["reason"],
      note: "Khách chưa nhận được kiện hàng.",
    });

    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.RETURN_REFUND);
    expect(order.deliveryConfirmationStatus).toBe(OrderDeliveryConfirmationStatus.ISSUE_REPORTED);
    expect(mockOrderEvents.publishDeliveryIssueReported).toHaveBeenCalledWith(orderId);
  });

  // Worker không được auto-complete order còn hạn hoặc đã chuyển sang issue.
  it("should skip auto-complete before the confirmation deadline", async () => {
    // Arrange
    const order = createDeliveredOrder();
    order.deliveryConfirmationDeadline = new Date(Date.now() + 60_000);
    mockTransaction(order);

    // Act
    const result = await target.autoComplete(orderId);

    // Assert
    expect(result).toBe(false);
    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.DELIVERED);
    expect(mockOrderEvents.publishDeliveryAutoConfirmed).not.toHaveBeenCalled();
  });
});
