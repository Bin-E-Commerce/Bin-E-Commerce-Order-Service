// Unit test cho use case checkout COD của Order Service.
// Các dependency HTTP và transaction được mock để kiểm tra business rule mà không cần chạy database thật.

import { Test, type TestingModule } from "@nestjs/testing";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { DataSource } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderItem } from "../../../database/entities/order-item.entity";
import { OrderStatusHistory } from "../../../database/entities/order-status-history.entity";
import { AuthClient } from "../clients/auth.client";
import { CartClient } from "../clients/cart.client";
import { ProductClient } from "../clients/product.client";
import { SellerShopClient } from "../clients/seller-shop.client";
import { CreateCodOrderDto } from "../dto/create-cod-order.dto";
import {
  EmptyCartError,
  IdempotencyConflictError,
} from "../errors/order.errors";
import { PaymentMethod } from "../enums/payment-method.enum";
import { OrderStatus } from "../enums/order-status.enum";
import { OrderRepository } from "../repositories/order.repository";
import { OrderResponseMapper } from "./order-response-mapper.service";
import { OrderCommandService } from "./order-command.service";
import { SellerOrderAccessService } from "./seller-order-access.service";
import { OrderEventsService } from "./order-events.service";

// Logger tối giản dùng cho TestingModule, không làm nhiễu output của unit test.
class MockLoggerService {
  // Mock logger giữ TestingModule im lặng trong unit test.
  log(): void {}

  // Mock logger nhận lỗi nhưng không ghi ra console.
  error(): void {}

  // Mock logger nhận cảnh báo nhưng không ghi ra console.
  warn(): void {}

  // Mock logger nhận debug log nhưng không ghi ra console.
  debug(): void {}

  // Mock logger nhận verbose log nhưng không ghi ra console.
  verbose(): void {}

  // Mock logger cập nhật context tương thích LoggerService của NestJS.
  setContext(): void {}
}

describe("OrderCommandService", () => {
  let target: OrderCommandService;
  let mockOrderRepository: DeepMocked<OrderRepository>;
  let mockCartClient: DeepMocked<CartClient>;
  let mockAuthClient: DeepMocked<AuthClient>;
  let mockProductClient: DeepMocked<ProductClient>;
  let mockSellerShopClient: DeepMocked<SellerShopClient>;
  let mockSellerOrderAccess: DeepMocked<SellerOrderAccessService>;
  let mockOrderEvents: DeepMocked<OrderEventsService>;
  let mockResponseMapper: DeepMocked<OrderResponseMapper>;
  let mockDataSource: DeepMocked<DataSource>;

  const ownerId = "owner-1";
  const addressId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const variantId = "33333333-3333-4333-8333-333333333333";
  const idempotencyKey = "checkout-key-001";

  // Tạo input checkout dùng chung để mỗi test chỉ tập trung vào một business rule.
  const createDto = (note = "Giao giờ hành chính"): CreateCodOrderDto => ({
    shippingAddressId: addressId,
    paymentMethod: PaymentMethod.COD,
    note,
  });

  // Tạo cart item snapshot giả lập từ Cart Service.
  const createCart = (quantity = 2) => ({
    id: "cart-1",
    ownerId,
    status: "ACTIVE" as const,
    items: [
      {
        productId,
        variantId,
        sellerShopId: null,
        sku: "SKU-001",
        productName: "Áo thể thao",
        variantName: "Đen - XL",
        imageUrl: null,
        unitPrice: "22000.00",
        quantity,
      },
    ],
  });

  // Tạo response reserve có giá chính thức để kiểm tra tổng tiền không lấy từ frontend.
  const createReservation = (quantity = 2) => ({
    reservationKey: idempotencyKey,
    items: [
      {
        productId,
        variantId,
        sellerShopId: "shop-1",
        sellerOwnerId: "seller-1",
        sku: "SKU-001",
        productName: "Áo thể thao chính thức",
        variantName: "Đen - XL",
        imageUrl: "https://cdn.example.com/product.jpg",
        unitPrice: "22000.00",
        quantity,
        lineTotal: "44000.00",
      },
    ],
  });

  // Khởi tạo TestingModule và mock mới cho từng test để không chia sẻ state giữa các case.
  beforeEach(async () => {
    mockOrderRepository = createMock<OrderRepository>();
    mockCartClient = createMock<CartClient>();
    mockAuthClient = createMock<AuthClient>();
    mockProductClient = createMock<ProductClient>();
    mockSellerShopClient = createMock<SellerShopClient>();
    mockSellerOrderAccess = createMock<SellerOrderAccessService>();
    mockOrderEvents = createMock<OrderEventsService>();
    mockResponseMapper = createMock<OrderResponseMapper>();
    mockDataSource = createMock<DataSource>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderCommandService,
        { provide: OrderRepository, useValue: mockOrderRepository },
        { provide: CartClient, useValue: mockCartClient },
        { provide: AuthClient, useValue: mockAuthClient },
        { provide: ProductClient, useValue: mockProductClient },
        { provide: SellerShopClient, useValue: mockSellerShopClient },
        { provide: SellerOrderAccessService, useValue: mockSellerOrderAccess },
        { provide: OrderEventsService, useValue: mockOrderEvents },
        { provide: OrderResponseMapper, useValue: mockResponseMapper },
        { provide: DataSource, useValue: mockDataSource },
      ],
    })
      .setLogger(new MockLoggerService())
      .compile();

    target = module.get<OrderCommandService>(OrderCommandService);
  });

  // Xóa toàn bộ call history sau mỗi test để các assertion luôn độc lập.
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("createCodOrder", () => {
    // Trả lại order cũ khi client retry cùng owner, key và payload.
    it("should return the existing order when idempotency key is retried with the same payload", async () => {
      // Arrange
      const existingOrder = {
        requestFingerprint: `${addressId}|${PaymentMethod.COD}|Giao giờ hành chính`,
      } as Order;
      const expectedResponse = { id: "order-1", status: "CONFIRMED" };
      mockOrderRepository.findByIdempotency.mockResolvedValue(existingOrder);
      mockResponseMapper.toResponse.mockReturnValue(expectedResponse as never);

      // Act
      const result = await target.createCodOrder(
        ownerId,
        createDto(),
        idempotencyKey,
      );

      // Assert
      expect(result).toEqual(expectedResponse);
      expect(mockResponseMapper.toResponse).toHaveBeenCalledWith(existingOrder);
      expect(mockCartClient.getActiveCart).not.toHaveBeenCalled();
      expect(mockProductClient.reserve).not.toHaveBeenCalled();
    });

    // Từ chối dùng lại key cho payload khác để tránh tạo order không xác định.
    it("should reject an idempotency key when the payload changes", async () => {
      // Arrange
      const existingOrder = {
        requestFingerprint: `${addressId}|${PaymentMethod.COD}|Địa chỉ khác`,
      } as Order;
      mockOrderRepository.findByIdempotency.mockResolvedValue(existingOrder);

      // Act & Assert
      await expect(
        target.createCodOrder(ownerId, createDto(), idempotencyKey),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(mockCartClient.getActiveCart).not.toHaveBeenCalled();
      expect(mockProductClient.reserve).not.toHaveBeenCalled();
    });

    // Không reserve tồn kho khi cart rỗng vì không có item hợp lệ để tạo order.
    it("should reject an empty cart before reserving inventory", async () => {
      // Arrange
      mockOrderRepository.findByIdempotency.mockResolvedValue(null);
      mockCartClient.getActiveCart.mockResolvedValue({
        ...createCart(),
        items: [],
      });

      // Act & Assert
      await expect(
        target.createCodOrder(ownerId, createDto(), idempotencyKey),
      ).rejects.toBeInstanceOf(EmptyCartError);
      expect(mockProductClient.reserve).not.toHaveBeenCalled();
      expect(mockAuthClient.getOwnedAddress).not.toHaveBeenCalled();
    });

    // Lưu order bằng giá Product Service trả về, tạo item snapshot và đóng cart sau commit.
    it("should create a confirmed COD order with authoritative product pricing", async () => {
      // Arrange
      const reservation = createReservation();
      const savedOrder = { id: "order-1", createdAt: new Date() } as Order;
      const orderRepository = {
        create: jest.fn((input: Partial<Order>) => ({
          ...input,
          id: savedOrder.id,
        })),
        save: jest.fn(async (input: Order) => ({ ...input, ...savedOrder })),
      };
      const itemRepository = {
        create: jest.fn((input: Partial<OrderItem>) => input),
        save: jest.fn(async (input: OrderItem[]) => input),
      };
      const historyRepository = {
        create: jest.fn((input: Partial<OrderStatusHistory>) => input),
        save: jest.fn(async (input: OrderStatusHistory) => input),
      };
      const manager = {
        getRepository: jest.fn((entity: unknown) => {
          if (entity === Order) return orderRepository;
          if (entity === OrderItem) return itemRepository;
          return historyRepository;
        }),
      };
      mockDataSource.transaction.mockImplementation(async (callback: any) =>
        callback(manager),
      );
      mockOrderRepository.findByIdempotency.mockResolvedValue(null);
      mockCartClient.getActiveCart.mockResolvedValue(createCart());
      mockAuthClient.getOwnedAddress.mockResolvedValue({
        id: addressId,
        label: "Nhà",
        fullName: "Nguyễn Văn A",
        phone: "0900000000",
        province: "Hồ Chí Minh",
        district: "Quận 1",
        ward: "Bến Nghé",
        street: "1 Nguyễn Huệ",
      });
      mockProductClient.reserve.mockResolvedValue(reservation);
      mockResponseMapper.toResponse.mockReturnValue({
        id: savedOrder.id,
      } as never);

      // Act
      const result = await target.createCodOrder(
        ownerId,
        createDto(),
        idempotencyKey,
      );

      // Assert
      expect(result).toEqual({ id: savedOrder.id });
      expect(orderRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId,
          subtotal: "44000.00",
          totalAmount: "44000.00",
          paymentMethod: PaymentMethod.COD,
        }),
      );
      expect(itemRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          productName: "Áo thể thao chính thức",
          unitPrice: "22000.00",
          quantity: 2,
          lineTotal: "44000.00",
        }),
      );
      expect(mockProductClient.reserve).toHaveBeenCalledWith(idempotencyKey, [
        { productId, variantId, quantity: 2 },
      ]);
      expect(mockOrderEvents.publishCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: savedOrder.id }),
        reservation.items,
      );
      expect(mockCartClient.checkoutCart).toHaveBeenCalledWith(ownerId);
    });

    // Chặn request thiếu user context hoặc thiếu idempotency key trước mọi I/O downstream.
    it("should reject an invalid request context before calling dependencies", async () => {
      // Arrange
      const dto = createDto();

      // Act & Assert
      await expect(
        target.createCodOrder("", dto, idempotencyKey),
      ).rejects.toThrow("Thiếu user context");
      await expect(
        target.createCodOrder(ownerId, dto, "short"),
      ).rejects.toThrow("Idempotency-Key");
      expect(mockOrderRepository.findByIdempotency).not.toHaveBeenCalled();
    });
  });

  describe("listOwnedOrders", () => {
    it("should return paginated summaries for the current owner", async () => {
      // Arrange
      const createdAt = new Date("2026-08-30T08:00:00.000Z");
      mockOrderRepository.findOwnedPage.mockResolvedValue([
        [
          {
            id: "order-1",
            orderNumber: "ORD-001",
            status: OrderStatus.CONFIRMED,
            paymentMethod: PaymentMethod.COD,
            totalAmount: "44000.00",
            items: [
              {
                quantity: 2,
                productName: "Áo thể thao",
                variantName: "Đen - XL",
                imageUrl: "https://cdn.example.com/product.jpg",
              },
            ],
            createdAt,
          } as Order,
        ],
        11,
      ]);

      // Act
      const result = await target.listOwnedOrders(ownerId, {
        page: 2,
        pageSize: 10,
      });

      // Assert
      expect(result).toEqual({
        items: [
          {
            id: "order-1",
            orderNumber: "ORD-001",
            status: OrderStatus.CONFIRMED,
            paymentMethod: PaymentMethod.COD,
            totalAmount: "44000.00",
            itemCount: 2,
            previewItems: [
              {
                productName: "Áo thể thao",
                variantName: "Đen - XL",
                imageUrl: "https://cdn.example.com/product.jpg",
                quantity: 2,
              },
            ],
            createdAt: createdAt.toISOString(),
          },
        ],
        total: 11,
        page: 2,
        pageSize: 10,
        totalPages: 2,
      });
      expect(mockOrderRepository.findOwnedPage).toHaveBeenCalledWith(
        ownerId,
        2,
        10,
        undefined,
      );
    });
  });

  describe("seller orders", () => {
    // Seller order luôn resolve shop từ user context và chỉ map dữ liệu đã được repository scope theo shop.
    it("should list shop-scoped orders without accepting a client shop id", async () => {
      const currentUser = {
        userId: "seller-user-1",
        email: "seller@example.com",
        permissions: ["seller.order.read"],
      };
      const order = {
        id: "order-1",
        orderNumber: "BIN-ORDER-1",
        items: [{ quantity: 2 }],
      } as Order;
      const expected = {
        id: order.id,
        orderNumber: order.orderNumber,
        shopItemTotal: "44000.00",
      };
      mockSellerOrderAccess.ensureCanRead.mockReturnValue(currentUser);
      mockSellerShopClient.getOwnedShopId.mockResolvedValue("shop-1");
      mockOrderRepository.findSellerPage.mockResolvedValue([[order], 1]);
      mockResponseMapper.toSellerListItem.mockReturnValue(expected as never);

      const result = await target.listSellerOrders(currentUser, {
        page: 1,
        pageSize: 10,
      });

      expect(result.items).toEqual([expected]);
      expect(mockSellerShopClient.getOwnedShopId).toHaveBeenCalledWith(
        currentUser,
      );
      expect(mockOrderRepository.findSellerPage).toHaveBeenCalledWith(
        "shop-1",
        1,
        10,
        { page: 1, pageSize: 10 },
      );
    });

    // Order không chứa item của shop phải trả not-found để không làm lộ order của seller khác.
    it("should hide an order that has no item for the current shop", async () => {
      const currentUser = {
        userId: "seller-user-1",
        email: "seller@example.com",
        permissions: ["seller.order.read"],
      };
      mockSellerOrderAccess.ensureCanRead.mockReturnValue(currentUser);
      mockSellerShopClient.getOwnedShopId.mockResolvedValue("shop-1");
      mockOrderRepository.findSellerById.mockResolvedValue(null);

      await expect(
        target.getSellerOrder(currentUser, "order-other-shop"),
      ).rejects.toThrow("Không tìm thấy đơn hàng");
      expect(mockOrderRepository.findSellerById).toHaveBeenCalledWith(
        "shop-1",
        "order-other-shop",
      );
      expect(mockResponseMapper.toSellerResponse).not.toHaveBeenCalled();
    });
  });

  describe("cancelOwnedOrder", () => {
    it("should release inventory and append cancellation history for a confirmed order", async () => {
      // Arrange
      const order = {
        id: "order-1",
        ownerId,
        status: OrderStatus.CONFIRMED,
        idempotencyKey,
        items: [{ variantId, quantity: 2 }],
      } as Order;
      const cancelledOrder = {
        ...order,
        status: OrderStatus.CANCELLED,
      } as Order;
      const lockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(order),
      };
      const orderRepository = {
        findOne: jest.fn().mockResolvedValue(order),
        createQueryBuilder: jest.fn().mockReturnValue(lockQueryBuilder),
        save: jest.fn().mockImplementation(async (value: Order) => value),
      };
      const historyRepository = {
        create: jest
          .fn()
          .mockImplementation((value: Partial<OrderStatusHistory>) => value),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const manager = {
        getRepository: jest.fn((entity: unknown) =>
          entity === Order ? orderRepository : historyRepository,
        ),
      };
      mockOrderRepository.findOwnedById
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce(cancelledOrder);
      mockProductClient.release.mockResolvedValue(undefined);
      mockDataSource.transaction.mockImplementation(async (callback: any) =>
        callback(manager),
      );
      mockResponseMapper.toResponse.mockReturnValue({
        id: "order-1",
        status: OrderStatus.CANCELLED,
      } as never);

      // Act
      const result = await target.cancelOwnedOrder(ownerId, "order-1", {
        reason: "Đổi ý",
      });

      // Assert
      expect(result).toEqual({ id: "order-1", status: OrderStatus.CANCELLED });
      expect(mockProductClient.release).toHaveBeenCalledWith(idempotencyKey, [
        { variantId, quantity: 2 },
      ]);
      expect(orderRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: OrderStatus.CANCELLED,
          cancelReason: "Đổi ý",
        }),
      );
      expect(historyRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: OrderStatus.CONFIRMED,
          toStatus: OrderStatus.CANCELLED,
          reason: "Đổi ý",
        }),
      );
      expect(mockOrderEvents.publishCancelled).toHaveBeenCalledWith(
        cancelledOrder,
      );
    });

    it("should keep confirmed order when inventory release fails", async () => {
      // Arrange
      const order = {
        id: "order-1",
        ownerId,
        status: OrderStatus.CONFIRMED,
        idempotencyKey,
        items: [{ variantId, quantity: 1 }],
      } as Order;
      mockOrderRepository.findOwnedById.mockResolvedValue(order);
      mockProductClient.release.mockRejectedValue(
        new Error("Product Service unavailable"),
      );

      // Act & Assert
      await expect(
        target.cancelOwnedOrder(ownerId, "order-1", {}),
      ).rejects.toThrow("Product Service unavailable");
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should return cancelled order without releasing inventory on a repeated request", async () => {
      // Arrange
      const order = {
        id: "order-1",
        ownerId,
        status: OrderStatus.CANCELLED,
      } as Order;
      const expected = { id: "order-1", status: OrderStatus.CANCELLED };
      mockOrderRepository.findOwnedById.mockResolvedValue(order);
      mockResponseMapper.toResponse.mockReturnValue(expected as never);

      // Act
      const result = await target.cancelOwnedOrder(ownerId, "order-1", {});

      // Assert
      expect(result).toEqual(expected);
      expect(mockProductClient.release).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
