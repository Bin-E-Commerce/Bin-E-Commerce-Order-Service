// File này đóng gói persistence query của Order để application service không phụ thuộc TypeORM API.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { FindOptionsWhere, Repository } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderStatus } from "../enums/order-status.enum";

// Cung cấp các query theo ownership và idempotency, không cho caller truyền owner tùy ý vào service khác.
@Injectable()
export class OrderRepository {
  constructor(
    @InjectRepository(Order) private readonly repository: Repository<Order>,
  ) {}

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

  // Dùng findAndCount để tổng số luôn phản ánh đúng filter owner/status của trang hiện tại.
  findOwnedPage(
    ownerId: string,
    page: number,
    pageSize: number,
    status?: OrderStatus,
  ): Promise<[Order[], number]> {
    const where: FindOptionsWhere<Order> = status
      ? { ownerId, status }
      : { ownerId };
    return this.repository.findAndCount({
      where,
      relations: { items: true },
      order: { createdAt: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  // Repository transaction được lấy từ DataSource ở command service để order và item commit cùng nhau.
  getEntityRepository(): Repository<Order> {
    return this.repository;
  }
}
