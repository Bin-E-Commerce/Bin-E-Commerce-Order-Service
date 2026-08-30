// File này đóng gói persistence query của Order để application service không phụ thuộc TypeORM API.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { FindOptionsWhere, Repository } from "typeorm";
import { Order } from "../../../database/entities/order.entity";
import { OrderStatus } from "../enums/order-status.enum";
import type { SellerOrderListQueryDto } from "../dto/seller-order-list-query.dto";

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

  // Lấy danh sách order có item thuộc shop bằng truy vấn hai bước để pagination không bị nhân bản bởi quan hệ 1-n.
  async findSellerPage(
    shopId: string,
    page: number,
    pageSize: number,
    query: SellerOrderListQueryDto,
  ): Promise<[Order[], number]> {
    const filterQuery = this.createSellerFilterQuery(shopId, query);
    const [rows, total] = await Promise.all([
      filterQuery
        .clone()
        .select("order.id", "id")
        .orderBy("order.created_at", "DESC")
        .addOrderBy("order.id", "DESC")
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getRawMany<{ id: string }>(),
      filterQuery.clone().getCount(),
    ]);

    const orderIds = rows.map((row) => row.id);
    if (orderIds.length === 0) return [[], total];

    const orders = await this.repository
      .createQueryBuilder("order")
      .leftJoinAndSelect(
        "order.items",
        "item",
        "item.seller_shop_id = :shopId",
        { shopId },
      )
      .where("order.id IN (:...orderIds)", { orderIds })
      .getMany();
    const orderById = new Map(orders.map((order) => [order.id, order]));
    return [
      orderIds
        .map((orderId) => orderById.get(orderId))
        .filter((order): order is Order => Boolean(order)),
      total,
    ];
  }

  // Chỉ trả detail khi order có item của shop hiện tại; join có điều kiện ngăn dữ liệu shop khác lọt vào response.
  findSellerById(shopId: string, orderId: string): Promise<Order | null> {
    return this.repository
      .createQueryBuilder("order")
      .leftJoinAndSelect(
        "order.items",
        "item",
        "item.seller_shop_id = :shopId",
        { shopId },
      )
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .where("order.id = :orderId", { orderId })
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM order_items seller_item
          WHERE seller_item.order_id = "order"."id"
            AND seller_item.seller_shop_id = :shopId
        )`,
        { shopId },
      )
      .getOne();
  }

  // Repository transaction được lấy từ DataSource ở command service để order và item commit cùng nhau.
  getEntityRepository(): Repository<Order> {
    return this.repository;
  }

  // Tập trung điều kiện shop/status/search để list và count dùng cùng một tập dữ liệu.
  private createSellerFilterQuery(
    shopId: string,
    query: SellerOrderListQueryDto,
  ) {
    const filterQuery = this.repository
      .createQueryBuilder("order")
      .where(
        `EXISTS (
          SELECT 1
          FROM order_items seller_item
          WHERE seller_item.order_id = "order"."id"
            AND seller_item.seller_shop_id = :shopId
        )`,
        { shopId },
      );

    if (query.status) {
      filterQuery.andWhere("order.status = :status", {
        status: query.status,
      });
    }

    const search = this.escapeLike(query.search?.trim() ?? "");
    if (search) {
      filterQuery.andWhere("order.order_number ILIKE :search", {
        search: `%${search}%`,
      });
    }

    return filterQuery;
  }

  // Escape wildcard của PostgreSQL để ô tìm mã đơn không biến thành truy vấn tùy ý.
  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, "\\$&");
  }
}
