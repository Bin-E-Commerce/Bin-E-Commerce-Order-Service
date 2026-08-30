// File này lưu snapshot từng dòng sản phẩm thuộc một Order; không tham chiếu entity Product Service.

import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Order } from "./order.entity";

// Item được giữ nguyên sau checkout dù catalog có đổi tên, ảnh hoặc giá.
@Entity({ name: "order_items" })
@Index("idx_order_items_seller_shop_order", ["sellerShopId", "orderId"])
export class OrderItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: "CASCADE" })
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @Column({ name: "product_id", type: "uuid" })
  productId!: string;

  @Column({ name: "variant_id", type: "uuid" })
  variantId!: string;

  @Column({ name: "seller_shop_id", type: "uuid", nullable: true })
  sellerShopId!: string | null;

  // Snapshot chủ shop tại thời điểm checkout để order vẫn phát đúng thông báo khi seller thay đổi hồ sơ về sau.
  @Column({ name: "seller_owner_id", type: "uuid", nullable: true })
  sellerOwnerId!: string | null;

  @Column({ type: "varchar", length: 160 })
  sku!: string;

  @Column({ name: "product_name", type: "varchar", length: 500 })
  productName!: string;

  @Column({ name: "variant_name", type: "varchar", length: 500 })
  variantName!: string;

  @Column({ name: "image_url", type: "text", nullable: true })
  imageUrl!: string | null;

  @Column({ name: "unit_price", type: "numeric", precision: 14, scale: 2 })
  unitPrice!: string;

  @Column({ type: "int" })
  quantity!: number;

  @Column({ name: "line_total", type: "numeric", precision: 14, scale: 2 })
  lineTotal!: string;
}
