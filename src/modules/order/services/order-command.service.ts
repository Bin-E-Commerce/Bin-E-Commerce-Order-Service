// Application service này điều phối use case tạo đơn COD.
// Thứ tự bắt buộc: đọc cart → xác nhận địa chỉ → reserve product → commit order → đóng cart.
// Product Service là nguồn sự thật cho giá và tồn kho; browser và Cart snapshot không được quyết định tổng tiền.
// Nếu commit order thất bại sau khi reserve, service gọi compensation release để không làm mất tồn kho.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { DataSource, QueryFailedError } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderItem } from "../../../database/entities/order-item.entity";
import { OrderStatusHistory } from "../../../database/entities/order-status-history.entity";
import { CartClient } from "../clients/cart.client";
import { AuthClient } from "../clients/auth.client";
import { ProductClient } from "../clients/product.client";
import { SellerShopClient } from "../clients/seller-shop.client";
import {
  ShippingClient,
  type GhnAddressSelectionInput,
  type ShippingQuote,
} from "../clients/shipping.client";
import {
  EmptyCartError,
  IdempotencyConflictError,
  OrderCancellationConflictError,
} from "../errors/order.errors";
import { OrderRepository } from "../repositories/order.repository";
import { OrderStatus } from "../../../database/enums/order-status.enum";
import { OrderFulfillmentStatus } from "../../../database/enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../../../database/enums/payment-status.enum";
import { PaymentMethod } from "../../../database/enums/payment-method.enum";
import type { CreateCodOrderDto } from "../dto/create-cod-order.dto";
import type {
  OrderListResponse,
  OrderResponse,
  SellerOrderListResponse,
  SellerOrderResponse,
} from "../types/order-response.type";
import type { CheckoutQuoteItem } from "../types/external-contracts.type";
import type { OrderListQueryDto } from "../dto/order-list-query.dto";
import type { CancelOrderDto } from "../dto/cancel-order.dto";
import type { SellerOrderListQueryDto } from "../dto/seller-order-list-query.dto";
import type { SellerOrderUserContext } from "../types/seller-order-user-context.type";
import { fromCents, toCents } from "../utils/order-money.util";
import { OrderResponseMapper } from "./order-response-mapper.service";
import { SellerOrderAccessService } from "./seller-order-access.service";
import { OrderEventsService } from "./order-events.service";

// Điều phối transaction boundary và giữ mọi kiểm tra ownership ở server-side.
@Injectable()
export class OrderCommandService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly cartClient: CartClient,
    private readonly authClient: AuthClient,
    private readonly productClient: ProductClient,
    private readonly sellerShopClient: SellerShopClient,
    private readonly sellerOrderAccess: SellerOrderAccessService,
    private readonly orderEvents: OrderEventsService,
    private readonly responseMapper: OrderResponseMapper,
    private readonly dataSource: DataSource,
    @Optional() private readonly shippingClient?: ShippingClient,
  ) {}

  // Tạo order COD idempotent; cùng user và cùng key sẽ nhận lại order cũ thay vì reserve stock lần hai.
  async createCodOrder(
    ownerId: string,
    dto: CreateCodOrderDto,
    idempotencyKey: string,
    ownerEmail?: string,
  ): Promise<OrderResponse> {
    this.validateRequestContext(ownerId, idempotencyKey);
    if (dto.paymentMethod !== PaymentMethod.COD) {
      throw new BadRequestException("Phase 1 chỉ hỗ trợ thanh toán COD.");
    }

    const fingerprint = this.createFingerprint(dto);
    const previousOrder = await this.orderRepository.findByIdempotency(
      ownerId,
      idempotencyKey,
    );
    if (previousOrder) {
      if (previousOrder.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      return this.responseMapper.toResponse(previousOrder);
    }

    const cart = await this.cartClient.getActiveCart(ownerId);
    if (cart.items.length === 0) throw new EmptyCartError();

    const address = await this.authClient.getOwnedAddress(
      ownerId,
      dto.shippingAddressId,
    );
    const reservation = await this.productClient.reserve(
      idempotencyKey,
      cart.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    );
    let shipping: { fee: string; breakdown: Array<Record<string, unknown>> };
    try {
      shipping = this.shippingClient
        ? await this.calculateShipping(reservation.items, address)
        : { fee: "0.00", breakdown: [] };
    } catch (error) {
      // Quote thất bại sau reserve phải release ngay để không làm treo tồn kho của khách.
      await this.productClient
        .release(
          idempotencyKey,
          reservation.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
        )
        .catch(() => undefined);
      throw error;
    }

    let savedOrder: Order;
    try {
      savedOrder = await this.persistOrder({
        ownerId,
        dto,
        idempotencyKey,
        fingerprint,
        address: {
          label: address.label,
          fullName: address.fullName,
          phone: address.phone,
          province: address.ghnProvinceName ?? address.province,
          district: address.ghnDistrictName ?? address.district,
          ward: address.ghnWardName ?? address.ward,
          street: address.street,
          ghnAddress: this.toGhnAddressSelection(address),
        },
        items: reservation.items,
        shippingFee: shipping.fee,
        shippingFeeBreakdown: shipping.breakdown,
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrentOrder = await this.orderRepository.findByIdempotency(
          ownerId,
          idempotencyKey,
        );
        if (
          concurrentOrder &&
          concurrentOrder.requestFingerprint === fingerprint
        ) {
          return this.responseMapper.toResponse(concurrentOrder);
        }
      }

      // Compensation chỉ chạy khi chưa có order concurrent sở hữu reservation này.
      await this.productClient
        .release(
          idempotencyKey,
          reservation.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
        )
        .catch(() => undefined);
      throw error;
    }

    // Phát event sau khi order và item đã commit; notification lỗi không làm checkout thất bại vì producer xử lý best-effort.
    if (ownerEmail?.trim()) {
      await this.orderEvents.publishCreated(
        savedOrder,
        reservation.items,
        ownerEmail.trim().toLowerCase(),
      );
    } else {
      await this.orderEvents.publishCreated(savedOrder, reservation.items);
    }

    try {
      await this.cartClient.checkoutCart(ownerId);
      return this.responseMapper.toResponse(savedOrder);
    } catch {
      // Order và stock đã hợp lệ; trả order thành công kèm cảnh báo để retry cleanup không tạo order trùng.
      return this.responseMapper.toResponse(savedOrder, [
        "Đơn đã được tạo nhưng giỏ hàng chưa được làm sạch. Hệ thống sẽ đồng bộ lại.",
      ]);
    }
  }

  // Quote phí theo từng shop sau khi Product Service đã xác nhận snapshot giá/quantity.
  async quoteOrder(
    ownerId: string,
    shippingAddressId: string,
    paymentMethod: PaymentMethod,
  ) {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    if (paymentMethod !== PaymentMethod.COD)
      throw new BadRequestException("Chỉ hỗ trợ thanh toán COD.");
    const cart = await this.cartClient.getActiveCart(ownerId);
    if (cart.items.length === 0) throw new EmptyCartError();
    const address = await this.authClient.getOwnedAddress(
      ownerId,
      shippingAddressId,
    );
    if (!this.shippingClient)
      throw new BadRequestException("Shipping Service chưa sẵn sàng.");
    const quoteSnapshot = await this.productClient.quote(
      `quote-${ownerId}-${shippingAddressId}-${Date.now()}`,
      cart.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    );
    const shipping = await this.calculateShipping(quoteSnapshot.items, address);
    const items = quoteSnapshot.items;
    const subtotal = fromCents(
      items.reduce((sum, item) => sum + toCents(item.lineTotal), 0n),
    );
    return {
      subtotal,
      shippingFee: shipping.fee,
      totalAmount: fromCents(toCents(subtotal) + toCents(shipping.fee)),
      shippingFeeBreakdown: shipping.breakdown,
      paymentMethod: PaymentMethod.COD,
    };
  }

  // Đọc order theo owner để trang kết quả không thể xem đơn của tài khoản khác.
  async getOwnedOrder(
    ownerId: string,
    orderId: string,
  ): Promise<OrderResponse> {
    const order = await this.orderRepository.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    return this.responseMapper.toResponse(order);
  }

  // Trả context tối thiểu cho Shipping Service; sellerUserId chỉ là audit context, shop scope vẫn được query từ Order DB.
  async getShippingContext(
    orderId: string,
    _sellerUserId: string,
    shopId: string,
  ): Promise<{
    orderId: string;
    orderNumber: string;
    ownerId: string;
    orderStatus: OrderStatus;
    shopId: string;
    shippingAddress: Record<string, unknown>;
    items: Array<{
      productId: string;
      productName: string;
      imageUrl: string | null;
      quantity: number;
      lineTotal: string;
    }>;
  }> {
    if (!shopId?.trim()) throw new BadRequestException("Thiếu shop context.");
    const order = await this.orderRepository.findSellerById(shopId, orderId);
    if (!order)
      throw new NotFoundException(
        "Không tìm thấy đơn hàng trong phạm vi shop.",
      );
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      ownerId: order.ownerId,
      orderStatus: order.status,
      shopId,
      shippingAddress: {
        contactName: order.shippingAddress.fullName ?? "",
        phone: order.shippingAddress.phone ?? "",
        addressLine: order.shippingAddress.street ?? "",
        province: order.shippingAddress.province ?? "",
        district: order.shippingAddress.district ?? "",
        ward: order.shippingAddress.ward ?? "",
        ...(order.shippingAddress.ghnAddress
          ? { ghnAddress: order.shippingAddress.ghnAddress }
          : {}),
      },
      items: (order.items ?? []).map((item) => ({
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        imageUrl: item.imageUrl,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        packageWeightGrams: item.packageWeightGrams,
        packageLengthCm: Number(item.packageLengthCm),
        packageWidthCm: Number(item.packageWidthCm),
        packageHeightCm: Number(item.packageHeightCm),
      })),
    };
  }

  // Xác nhận owner ở lớp repository để Shipping Service không thể tự cấp quyền tracking bằng dữ liệu client.
  async assertOwnedOrder(ownerId: string, orderId: string): Promise<void> {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    const order = await this.orderRepository.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
  }

  // Trả danh sách order theo owner, filter trạng thái và phân trang server-side.
  async listOwnedOrders(
    ownerId: string,
    query: OrderListQueryDto,
  ): Promise<OrderListResponse> {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const [orders, total] = query.stage
      ? await this.orderRepository.findOwnedPage(
          ownerId,
          page,
          pageSize,
          query.status,
          query.stage,
        )
      : await this.orderRepository.findOwnedPage(
          ownerId,
          page,
          pageSize,
          query.status,
        );
    return {
      items: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        ...(order.fulfillmentStatus
          ? { fulfillmentStatus: order.fulfillmentStatus }
          : {}),
        ...(order.paymentStatus ? { paymentStatus: order.paymentStatus } : {}),
        paymentMethod: order.paymentMethod,
        totalAmount: order.totalAmount,
        itemCount:
          order.items?.reduce((count, item) => count + item.quantity, 0) ?? 0,
        previewItems: (order.items ?? []).slice(0, 2).map((item) => ({
          ...(item.productId ? { productId: item.productId } : {}),
          ...(item.variantId ? { variantId: item.variantId } : {}),
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          quantity: item.quantity,
        })),
        createdAt: order.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }

  // Release reservation trước, sau đó khóa order để hai request hủy đồng thời chỉ chuyển trạng thái một lần.
  // Trả danh sách order có item của shop hiện tại; shop scope được resolve từ user context trước khi query database.
  async listSellerOrders(
    currentUser: SellerOrderUserContext,
    query: SellerOrderListQueryDto,
  ): Promise<SellerOrderListResponse> {
    const user = this.sellerOrderAccess.ensureCanRead(currentUser);
    const shopId = await this.sellerShopClient.getOwnedShopId(user);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const [orders, total] = await this.orderRepository.findSellerPage(
      shopId,
      page,
      pageSize,
      query,
    );

    return {
      items: orders.map((order) => this.responseMapper.toSellerListItem(order)),
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }

  // Trả detail Seller sau khi xác minh shop thuộc user; order không có item của shop sẽ được che dưới dạng not-found.
  async getSellerOrder(
    currentUser: SellerOrderUserContext,
    orderId: string,
  ): Promise<SellerOrderResponse> {
    const user = this.sellerOrderAccess.ensureCanRead(currentUser);
    const shopId = await this.sellerShopClient.getOwnedShopId(user);
    const order = await this.orderRepository.findSellerById(shopId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    return this.responseMapper.toSellerResponse(order);
  }

  async cancelOwnedOrder(
    ownerId: string,
    orderId: string,
    dto: CancelOrderDto,
    ownerEmail?: string,
  ): Promise<OrderResponse> {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    const order = await this.orderRepository.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    if (order.status === OrderStatus.CANCELLED)
      return this.responseMapper.toResponse(order);
    if (order.status !== OrderStatus.CONFIRMED) {
      throw new OrderCancellationConflictError(order.status);
    }

    await this.productClient.release(
      order.idempotencyKey,
      (order.items ?? []).map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    );

    const didCancel = await this.dataSource.transaction(async (manager) => {
      const lockedOrder = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .where("order.id = :orderId", { orderId })
        .andWhere("order.owner_id = :ownerId", { ownerId })
        .setLock("pessimistic_write")
        .getOne();
      if (!lockedOrder) throw new NotFoundException("Không tìm thấy đơn hàng.");
      if (lockedOrder.status === OrderStatus.CANCELLED) return false;
      if (lockedOrder.status !== OrderStatus.CONFIRMED) {
        throw new OrderCancellationConflictError(lockedOrder.status);
      }
      lockedOrder.status = OrderStatus.CANCELLED;
      lockedOrder.fulfillmentStatus = OrderFulfillmentStatus.CANCELLED;
      lockedOrder.cancelReason = dto.reason?.trim() || null;
      lockedOrder.cancelledAt = new Date();
      await manager.getRepository(Order).save(lockedOrder);
      await manager.getRepository(OrderStatusHistory).save(
        manager.getRepository(OrderStatusHistory).create({
          orderId,
          fromStatus: OrderStatus.CONFIRMED,
          toStatus: OrderStatus.CANCELLED,
          reason: lockedOrder.cancelReason ?? "Khách hàng hủy đơn.",
        }),
      );
      return true;
    });

    const cancelledOrder = await this.orderRepository.findOwnedById(
      ownerId,
      orderId,
    );
    if (!cancelledOrder)
      throw new NotFoundException("Không tìm thấy đơn hàng.");
    if (didCancel) {
      if (ownerEmail?.trim()) {
        await this.orderEvents.publishCancelled(
          cancelledOrder,
          ownerEmail.trim().toLowerCase(),
        );
      } else {
        await this.orderEvents.publishCancelled(cancelledOrder);
      }
    }
    return this.responseMapper.toResponse(cancelledOrder);
  }

  // Lưu aggregate, item snapshot và audit history trong cùng một transaction database.
  private async persistOrder(input: {
    ownerId: string;
    dto: CreateCodOrderDto;
    idempotencyKey: string;
    fingerprint: string;
    address: Record<string, unknown>;
    items: CheckoutQuoteItem[];
    shippingFee: string;
    shippingFeeBreakdown: Array<Record<string, unknown>>;
  }): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Order);
      const subtotalCents = input.items.reduce(
        (total, item) =>
          total + toCents(item.unitPrice) * BigInt(item.quantity),
        0n,
      );
      const subtotal = fromCents(subtotalCents);
      const order = repository.create({
        orderNumber: this.generateOrderNumber(),
        ownerId: input.ownerId,
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: OrderFulfillmentStatus.TO_SHIP,
        paymentStatus: PaymentStatus.COD_PENDING_COLLECTION,
        paymentMethod: PaymentMethod.COD,
        shippingAddressId: input.dto.shippingAddressId,
        shippingAddress: input.address,
        subtotal,
        shippingFee: input.shippingFee,
        shippingFeeBreakdown: input.shippingFeeBreakdown,
        totalAmount: fromCents(toCents(subtotal) + toCents(input.shippingFee)),
        note: input.dto.note?.trim() || null,
        cancelReason: null,
        cancelledAt: null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.fingerprint,
      });
      const savedOrder = await repository.save(order);

      const itemRepository = manager.getRepository(OrderItem);
      const orderItems = input.items.map((item) =>
        itemRepository.create({
          orderId: savedOrder.id,
          productId: item.productId,
          variantId: item.variantId,
          sellerShopId: item.sellerShopId,
          sellerOwnerId: item.sellerOwnerId,
          sku: item.sku,
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          lineTotal: fromCents(toCents(item.unitPrice) * BigInt(item.quantity)),
          packageWeightGrams: item.packageWeightGrams,
          packageLengthCm: String(item.packageLengthCm),
          packageWidthCm: String(item.packageWidthCm),
          packageHeightCm: String(item.packageHeightCm),
        }),
      );
      await itemRepository.save(orderItems);

      const historyRepository = manager.getRepository(OrderStatusHistory);
      await historyRepository.save(
        historyRepository.create({
          orderId: savedOrder.id,
          fromStatus: null,
          toStatus: OrderStatus.CONFIRMED,
          reason: "Checkout COD đã xác nhận và giữ tồn kho thành công.",
        }),
      );

      savedOrder.items = orderItems;
      return savedOrder;
    });
  }

  // Group item theo seller shop và cộng quote riêng để không làm lộ hoặc cộng nhầm doanh thu shop khác.
  private async calculateShipping(
    items: CheckoutQuoteItem[],
    address: {
      fullName: string;
      phone: string;
      street: string;
      district: string;
      ward: string;
      province: string;
      ghnProvinceName: string | null;
      ghnProvinceId: number | null;
      ghnDistrictId: number | null;
      ghnWardCode: string | null;
      ghnDistrictName: string | null;
      ghnWardName: string | null;
    },
  ) {
    const groups = new Map<string, CheckoutQuoteItem[]>();
    for (const item of items) {
      if (!item.sellerShopId)
        throw new BadRequestException(
          "Sản phẩm chưa có shop giao hàng hợp lệ.",
        );
      groups.set(item.sellerShopId, [
        ...(groups.get(item.sellerShopId) ?? []),
        item,
      ]);
    }
    const quotes = await Promise.all(
      [...groups.entries()].map(async ([shopId, shopItems]) => {
        const weight = shopItems.reduce(
          (sum, item) => sum + item.packageWeightGrams * item.quantity,
          0,
        );
        if (
          !shopItems.every(
            (item) =>
              item.packageWeightGrams > 0 &&
              item.packageLengthCm > 0 &&
              item.packageWidthCm > 0 &&
              item.packageHeightCm > 0,
          )
        ) {
          throw new BadRequestException(
            "Sản phẩm chưa đủ thông tin đóng gói để tính phí giao hàng.",
          );
        }
        const length = Math.max(
          ...shopItems.map((item) => item.packageLengthCm),
        );
        const width = Math.max(...shopItems.map((item) => item.packageWidthCm));
        const height = shopItems.reduce(
          (sum, item) => sum + item.packageHeightCm * item.quantity,
          0,
        );
        const value = Number(
          fromCents(
            shopItems.reduce((sum, item) => sum + toCents(item.lineTotal), 0n),
          ),
        );
        return this.shippingClient!.calculateQuote({
          shopId,
          to: {
            contactName: address.fullName,
            phone: address.phone,
            addressLine: address.street,
            province: address.ghnProvinceName ?? address.province,
            district: address.ghnDistrictName ?? address.district,
            ward: address.ghnWardName ?? address.ward,
            ghnAddress: this.toGhnAddressSelection(address),
          },
          weightGrams: weight,
          lengthCm: length,
          widthCm: width,
          heightCm: height,
          value,
          codAmount: value,
        });
      }),
    );
    const fee = fromCents(
      quotes.reduce((sum, quote) => sum + toCents(quote.fee), 0n),
    );
    return {
      fee,
      breakdown: quotes.map((quote) => ({
        ...quote,
        estimatedDeliveryAt: quote.estimatedDeliveryAt,
      })),
    };
  }

  // Tạo selection GHN trực tiếp từ địa chỉ Auth đã lưu để checkout không gửi mã địa lý tùy ý từ browser.
  private toGhnAddressSelection(address: {
    ghnProvinceId: number | null;
    ghnProvinceName: string | null;
    ghnDistrictId: number | null;
    ghnWardCode: string | null;
    ghnDistrictName: string | null;
    ghnWardName: string | null;
  }): GhnAddressSelectionInput {
    if (
      !address.ghnProvinceId ||
      !address.ghnProvinceName ||
      !address.ghnDistrictId ||
      !address.ghnDistrictName ||
      !address.ghnWardCode ||
      !address.ghnWardName
    ) {
      throw new BadRequestException(
        "Địa chỉ giao hàng chưa có đủ mã GHN. Vui lòng cập nhật lại địa chỉ.",
      );
    }
    return {
      provinceId: address.ghnProvinceId,
      districtId: address.ghnDistrictId,
      wardCode: address.ghnWardCode,
      districtName: address.ghnDistrictName,
      wardName: address.ghnWardName,
    };
  }

  // Nhân tiền snapshot bằng số nguyên cent để không sai số float.
  private multiplyMoney(value: string, quantity: number): string {
    return fromCents(toCents(value) * BigInt(quantity));
  }

  // Fingerprint giúp cùng idempotency key không bị tái sử dụng cho địa chỉ hoặc phương thức khác.
  private createFingerprint(dto: CreateCodOrderDto): string {
    return `${dto.shippingAddressId}|${dto.paymentMethod}|${dto.note?.trim() ?? ""}`;
  }

  // Kiểm tra context do Gateway inject trước khi chạm vào database hoặc service downstream.
  private validateRequestContext(
    ownerId: string,
    idempotencyKey: string,
  ): void {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException(
        "Idempotency-Key phải dài từ 8 đến 128 ký tự.",
      );
    }
  }

  // Sinh mã hiển thị ngắn, còn UUID mới là định danh kỹ thuật của order.
  private generateOrderNumber(): string {
    const timePart = Date.now().toString(36).toUpperCase();
    const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `BIN-${timePart}-${randomPart}`;
  }

  // PostgreSQL dùng mã 23505 cho race idempotency; các lỗi khác phải được ném nguyên trạng.
  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string }).code === "23505";
  }
}
