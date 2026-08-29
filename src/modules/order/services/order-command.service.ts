// Application service này điều phối use case tạo đơn COD.
// Thứ tự bắt buộc: đọc cart → xác nhận địa chỉ → reserve product → commit order → đóng cart.
// Product Service là nguồn sự thật cho giá và tồn kho; browser và Cart snapshot không được quyết định tổng tiền.
// Nếu commit order thất bại sau khi reserve, service gọi compensation release để không làm mất tồn kho.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, QueryFailedError } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderItem } from "../../../database/entities/order-item.entity";
import { OrderStatusHistory } from "../../../database/entities/order-status-history.entity";
import { CartClient } from "../clients/cart.client";
import { AuthClient } from "../clients/auth.client";
import { ProductClient } from "../clients/product.client";
import {
  EmptyCartError,
  IdempotencyConflictError,
} from "../errors/order.errors";
import { OrderRepository } from "../repositories/order.repository";
import { OrderStatus } from "../enums/order-status.enum";
import { PaymentMethod } from "../enums/payment-method.enum";
import type { CreateCodOrderDto } from "../dto/create-cod-order.dto";
import type { OrderResponse } from "../types/order-response.type";
import type { CheckoutQuoteItem } from "../types/external-contracts.type";
import { fromCents, toCents } from "../utils/order-money.util";
import { OrderResponseMapper } from "./order-response-mapper.service";

// Điều phối transaction boundary và giữ mọi kiểm tra ownership ở server-side.
@Injectable()
export class OrderCommandService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly cartClient: CartClient,
    private readonly authClient: AuthClient,
    private readonly productClient: ProductClient,
    private readonly responseMapper: OrderResponseMapper,
    private readonly dataSource: DataSource,
  ) {}

  // Tạo order COD idempotent; cùng user và cùng key sẽ nhận lại order cũ thay vì reserve stock lần hai.
  async createCodOrder(
    ownerId: string,
    dto: CreateCodOrderDto,
    idempotencyKey: string,
  ): Promise<OrderResponse> {
    this.validateRequestContext(ownerId, idempotencyKey);
    if (dto.paymentMethod !== PaymentMethod.COD) {
      throw new BadRequestException("Phase 1 chỉ hỗ trợ thanh toán COD.");
    }

    const fingerprint = this.createFingerprint(dto);
    const previousOrder = await this.orderRepository.findByIdempotency(ownerId, idempotencyKey);
    if (previousOrder) {
      if (previousOrder.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      return this.responseMapper.toResponse(previousOrder);
    }

    const cart = await this.cartClient.getActiveCart(ownerId);
    if (cart.items.length === 0) throw new EmptyCartError();

    const address = await this.authClient.getOwnedAddress(ownerId, dto.shippingAddressId);
    const reservation = await this.productClient.reserve(
      idempotencyKey,
      cart.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    );

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
          province: address.province,
          district: address.district,
          ward: address.ward,
          street: address.street,
        },
        items: reservation.items,
      });
    } catch (error) {
      // Compensation chỉ chạy sau khi Product Service đã xác nhận reserve thành công.
      await this.productClient.release(
        idempotencyKey,
        reservation.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      ).catch(() => undefined);

      if (this.isUniqueViolation(error)) {
        const concurrentOrder = await this.orderRepository.findByIdempotency(ownerId, idempotencyKey);
        if (concurrentOrder && concurrentOrder.requestFingerprint === fingerprint) {
          return this.responseMapper.toResponse(concurrentOrder);
        }
      }
      throw error;
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

  // Đọc order theo owner để trang kết quả không thể xem đơn của tài khoản khác.
  async getOwnedOrder(ownerId: string, orderId: string): Promise<OrderResponse> {
    const order = await this.orderRepository.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    return this.responseMapper.toResponse(order);
  }

  // Lưu aggregate, item snapshot và audit history trong cùng một transaction database.
  private async persistOrder(input: {
    ownerId: string;
    dto: CreateCodOrderDto;
    idempotencyKey: string;
    fingerprint: string;
    address: Record<string, string>;
    items: CheckoutQuoteItem[];
  }): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Order);
      const subtotalCents = input.items.reduce(
        (total, item) => total + toCents(item.unitPrice) * BigInt(item.quantity),
        0n,
      );
      const subtotal = fromCents(subtotalCents);
      const order = repository.create({
        orderNumber: this.generateOrderNumber(),
        ownerId: input.ownerId,
        status: OrderStatus.CONFIRMED,
        paymentMethod: PaymentMethod.COD,
        shippingAddressId: input.dto.shippingAddressId,
        shippingAddress: input.address,
        subtotal,
        shippingFee: "0.00",
        totalAmount: subtotal,
        note: input.dto.note?.trim() || null,
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
          sku: item.sku,
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          lineTotal: fromCents(toCents(item.unitPrice) * BigInt(item.quantity)),
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

  // Fingerprint giúp cùng idempotency key không bị tái sử dụng cho địa chỉ hoặc phương thức khác.
  private createFingerprint(dto: CreateCodOrderDto): string {
    return `${dto.shippingAddressId}|${dto.paymentMethod}|${dto.note?.trim() ?? ""}`;
  }

  // Kiểm tra context do Gateway inject trước khi chạm vào database hoặc service downstream.
  private validateRequestContext(ownerId: string, idempotencyKey: string): void {
    if (!ownerId?.trim()) throw new BadRequestException("Thiếu user context.");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException("Idempotency-Key phải dài từ 8 đến 128 ký tự.");
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
