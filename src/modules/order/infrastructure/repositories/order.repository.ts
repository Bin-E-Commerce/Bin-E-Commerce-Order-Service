// File này đóng gói persistence query của Order để application service không phụ thuộc TypeORM API.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { FindOptionsWhere, Repository } from "typeorm";
import { Order } from "../../../../database/order/entities/order.entity";
import { OrderItem } from "../../../../database/order/entities/order-item.entity";
import { OrderStatus } from "../../../../database/order/enums/order-status.enum";
import { OrderFulfillmentStatus } from "../../../../database/order/enums/order-fulfillment-status.enum";
import { OrderReturnRequest } from "../../../../database/returns/entities/order-return-request.entity";
import { OrderReturnStatus } from "../../../../database/returns/enums/order-return-status.enum";
import type { SellerOrderListQueryDto } from "../../presentation/dto/seller-order-list-query.dto";
import type {
  CustomerOrderTabCounts,
  SellerOrderTabCounts,
} from "../../application/types/order-response.type";

// Các trạng thái này cho biết item đã đi vào quy trình hoàn thực tế; item bị từ chối hoặc customer tự hủy vẫn là một lượt bán hợp lệ.
const RETURN_STATUSES_EXCLUDED_FROM_SALES = [
  OrderReturnStatus.AWAITING_SHIPMENT,
  OrderReturnStatus.IN_TRANSIT,
  OrderReturnStatus.SHIPMENT_FAILED,
  OrderReturnStatus.RECEIVED,
  OrderReturnStatus.INSPECTION_FAILED,
  OrderReturnStatus.REFUND_PENDING,
];

// Cung cấp các query theo ownership và idempotency, không cho caller truyền owner tùy ý vào service khác.
@Injectable()
export class OrderRepository {
  constructor(
    @InjectRepository(Order) private readonly repository: Repository<Order>,
    @InjectRepository(OrderReturnRequest)
    private readonly returnRepository: Repository<OrderReturnRequest>,
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
    stage?: OrderFulfillmentStatus,
  ): Promise<[Order[], number]> {
    const where: FindOptionsWhere<Order> = stage
      ? { ownerId, fulfillmentStatus: stage }
      : status
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

  // Đếm một lần cho toàn bộ nhóm tab của owner; dùng FILTER giúp UI hiển thị badge nhất quán mà không cần gọi nhiều endpoint.
  async countOwnedTabs(ownerId: string): Promise<CustomerOrderTabCounts> {
    const row = await this.repository
      .createQueryBuilder("order")
      .select("COUNT(*)", "total")
      .addSelect(
        "COUNT(*) FILTER (WHERE order.status = :pendingStatus)",
        "pendingPayment",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :toShip)",
        "toShip",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :shipping)",
        "shipping",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :delivered)",
        "delivered",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :completed)",
        "completed",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :cancelled)",
        "cancelled",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE order.fulfillment_status = :returnRefund)",
        "returnRefund",
      )
      .where("order.owner_id = :ownerId", { ownerId })
      .setParameters({
        pendingStatus: OrderStatus.PENDING,
        toShip: OrderFulfillmentStatus.TO_SHIP,
        shipping: OrderFulfillmentStatus.SHIPPING,
        delivered: OrderFulfillmentStatus.DELIVERED,
        completed: OrderFulfillmentStatus.COMPLETED,
        cancelled: OrderFulfillmentStatus.CANCELLED,
        returnRefund: OrderFulfillmentStatus.RETURN_REFUND,
      })
      .getRawOne<Record<string, string>>();

    return {
      all: Number(row?.total ?? 0),
      pendingPayment: Number(row?.pendingPayment ?? 0),
      toShip: Number(row?.toShip ?? 0),
      shipping: Number(row?.shipping ?? 0),
      delivered: Number(row?.delivered ?? 0),
      completed: Number(row?.completed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      returnRefund: Number(row?.returnRefund ?? 0),
    };
  }

  // Đếm order có item thuộc shop theo từng stage và chỉ đếm return request còn việc Seller phải xử lý.
  async countSellerTabs(shopId: string): Promise<SellerOrderTabCounts> {
    const [row, actionableReturnRow] = await Promise.all([
      this.repository
        .createQueryBuilder("order")
        .select("COUNT(*)", "total")
        .addSelect(
          "COUNT(*) FILTER (WHERE order.fulfillment_status = :toShip)",
          "toShip",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE order.fulfillment_status = :shipping)",
          "shipping",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE order.fulfillment_status = :delivered)",
          "delivered",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE order.fulfillment_status = :completed)",
          "completed",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE order.fulfillment_status = :cancelled)",
          "cancelled",
        )
        .where(
          `EXISTS (
            SELECT 1
            FROM order_items seller_item
            WHERE seller_item.order_id = "order"."id"
              AND seller_item.seller_shop_id = :shopId
          )`,
          { shopId },
        )
        .setParameters({
          toShip: OrderFulfillmentStatus.TO_SHIP,
          shipping: OrderFulfillmentStatus.SHIPPING,
          delivered: OrderFulfillmentStatus.DELIVERED,
          completed: OrderFulfillmentStatus.COMPLETED,
          cancelled: OrderFulfillmentStatus.CANCELLED,
        })
        .getRawOne<Record<string, string>>(),
      this.returnRepository
        .createQueryBuilder("return_request")
        .select("COUNT(*)", "count")
        .where("return_request.shop_id = :shopId", { shopId })
        .andWhere("return_request.status IN (:...actionableStatuses)", {
          actionableStatuses: [
            OrderReturnStatus.REQUESTED,
            OrderReturnStatus.RECEIVED,
          ],
        })
        .getRawOne<{ count: string }>(),
    ]);

    return {
      all: Number(row?.total ?? 0),
      toShip: Number(row?.toShip ?? 0),
      shipping: Number(row?.shipping ?? 0),
      delivered: Number(row?.delivered ?? 0),
      completed: Number(row?.completed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      returnRefund: Number(actionableReturnRow?.count ?? 0),
    };
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

  // Tìm order item cho Product Service kiểm tra purchase proof mà không tạo foreign key hoặc truy cập database cross-service.
  findReviewContextByItemId(orderItemId: string): Promise<Order | null> {
    return this.repository
      .createQueryBuilder("order")
      .innerJoinAndSelect("order.items", "item", "item.id = :orderItemId", { orderItemId })
      .where("order.id = item.order_id")
      .getOne();
  }

  // Tổng hợp số lượng bán theo từng item thay vì theo trạng thái tổng của order.
  // Order RETURN_REFUND vẫn giữ các item không hoàn để không làm mất lượt bán của sản phẩm khác trong cùng đơn.
  // Chỉ item đã đi vào quy trình hoàn mới bị loại; request bị từ chối hoặc customer tự hủy vẫn được tính như một sale.
  async findSoldQuantities(
    sellerOwnerId: string,
    productIds: string[],
  ): Promise<Array<{ productId: string; quantitySold: number }>> {
    if (!sellerOwnerId || productIds.length === 0) return [];

    const rows = await this.repository
      .createQueryBuilder("saleOrder")
      .innerJoin(OrderItem, "item", "item.order_id = saleOrder.id")
      .select("item.product_id", "productId")
      .addSelect(
        `COALESCE(
          SUM(item.quantity) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM order_return_requests return_request
              WHERE return_request.order_id = saleOrder.id
                AND return_request.status IN (:...returnStatusesExcludedFromSales)
                AND return_request.item_ids @> jsonb_build_array(item.id::text)
            )
          ),
          0
        )`,
        "quantitySold",
      )
      .where("item.seller_owner_id = :sellerOwnerId", { sellerOwnerId })
      .andWhere("item.product_id IN (:...productIds)", { productIds })
      .andWhere("saleOrder.status = :confirmedStatus", {
        confirmedStatus: OrderStatus.CONFIRMED,
      })
      .andWhere("saleOrder.fulfillment_status IN (:...saleStatuses)", {
        saleStatuses: [
          OrderFulfillmentStatus.COMPLETED,
          OrderFulfillmentStatus.RETURN_REFUND,
        ],
      })
      .setParameter(
        "returnStatusesExcludedFromSales",
        RETURN_STATUSES_EXCLUDED_FROM_SALES,
      )
      .groupBy("item.product_id")
      .getRawMany<{ productId: string; quantitySold: string }>();

    return rows.map((row) => ({
      productId: row.productId,
      quantitySold: Number(row.quantitySold),
    }));
  }

  // Lấy các order đã quá deadline để worker xử lý từng order trong transaction có khóa pessimistic.
  findExpiredDeliveryConfirmations(now: Date, limit = 50): Promise<Order[]> {
    return this.repository
      .createQueryBuilder("order")
      .where("order.fulfillment_status = :stage", { stage: OrderFulfillmentStatus.DELIVERED })
      .andWhere("order.delivery_confirmation_status = :confirmationStatus", { confirmationStatus: "PENDING" })
      .andWhere("order.delivery_confirmation_deadline <= :now", { now })
      .andWhere(`NOT EXISTS (
        SELECT 1 FROM order_delivery_issues issue
        WHERE issue.order_id = order.id AND issue.status = 'OPEN'
      )`)
      .orderBy("order.delivery_confirmation_deadline", "ASC")
      .take(limit)
      .getMany();
  }

  // Tập trung điều kiện shop/status/search để list và count dùng cùng một tập dữ liệu.
  private createSellerFilterQuery(
    shopId: string,
    query: SellerOrderListQueryDto,
  ) {
    const filterQuery = this.repository.createQueryBuilder("order").where(
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

    if (query.stage) {
      filterQuery.andWhere("order.fulfillment_status = :stage", {
        stage: query.stage,
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
