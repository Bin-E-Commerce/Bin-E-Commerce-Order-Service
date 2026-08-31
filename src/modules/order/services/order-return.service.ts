// Service này xử lý quyền customer/seller và state transition của return request, refund chỉ mô phỏng.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { OrderReturnRequest } from "../../../database/entities/order-return-request.entity";
import { OrderReturnStatus } from "../../../database/enums/order-return-status.enum";
import { OrderFulfillmentStatus } from "../../../database/enums/order-fulfillment-status.enum";
import { OrderRepository } from "../repositories/order.repository";
import { SellerShopClient } from "../clients/seller-shop.client";
import type {
  CreateOrderReturnDto,
  ReviewOrderReturnDto,
} from "../dto/order-return.dto";
import type { SellerOrderUserContext } from "../types/seller-order-user-context.type";

// Orchestrate return request với ownership đã xác minh tại Order Repository/Seller Service.
@Injectable()
export class OrderReturnService {
  constructor(
    @InjectRepository(OrderReturnRequest)
    private readonly repository: Repository<OrderReturnRequest>,
    private readonly orders: OrderRepository,
    private readonly sellerShopClient: SellerShopClient,
  ) {}

  // Customer chỉ request trong 7 ngày sau completed và item phải thuộc order của mình.
  async create(ownerId: string, orderId: string, dto: CreateOrderReturnDto) {
    const order = await this.orders.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    if (order.fulfillmentStatus !== OrderFulfillmentStatus.COMPLETED)
      throw new ConflictException("Đơn hàng chưa đủ điều kiện trả hàng.");
    if (order.returnWindowUntil && order.returnWindowUntil < new Date())
      throw new ConflictException("Đã hết thời hạn trả hàng.");
    const items = new Map((order.items ?? []).map((item) => [item.id, item]));
    if (dto.itemIds.some((itemId) => !items.has(itemId)))
      throw new BadRequestException("Sản phẩm trả hàng không thuộc đơn.");
    const shopIds = new Set(
      dto.itemIds
        .map((itemId) => items.get(itemId)!.sellerShopId)
        .filter((id): id is string => Boolean(id)),
    );
    if (shopIds.size !== 1)
      throw new BadRequestException("Mỗi yêu cầu chỉ được thuộc một shop.");
    const existing = await this.repository.findOne({
      where: { orderId, ownerId, status: OrderReturnStatus.REQUESTED },
    });
    if (existing) return existing;
    return this.repository.save(
      this.repository.create({
        orderId,
        ownerId,
        shopId: [...shopIds][0],
        itemIds: dto.itemIds,
        status: OrderReturnStatus.REQUESTED,
        reason: dto.reason.trim(),
        description: dto.description?.trim() || null,
        reviewNote: null,
        reviewedAt: null,
      }),
    );
  }

  // Customer xem các request thuộc order của chính mình.
  async list(ownerId: string, orderId: string) {
    const order = await this.orders.findOwnedById(ownerId, orderId);
    if (!order) throw new NotFoundException("Không tìm thấy đơn hàng.");
    return this.repository.find({
      where: { orderId, ownerId },
      order: { createdAt: "DESC" },
    });
  }

  // Seller approve/reject chỉ được tác động request thuộc shop resolve từ user context.
  async review(
    currentUser: SellerOrderUserContext,
    orderId: string,
    returnId: string,
    dto: ReviewOrderReturnDto,
    status: OrderReturnStatus,
  ) {
    const shopId = await this.sellerShopClient.getOwnedShopId(currentUser);
    const request = await this.repository.findOne({
      where: { id: returnId, orderId, shopId },
    });
    if (!request)
      throw new NotFoundException("Không tìm thấy yêu cầu trả hàng.");
    if (request.status !== OrderReturnStatus.REQUESTED)
      throw new ConflictException("Yêu cầu đã được xử lý.");
    request.status = status;
    request.reviewNote = dto.note?.trim() || null;
    request.reviewedAt = new Date();
    return this.repository.save(request);
  }
}
