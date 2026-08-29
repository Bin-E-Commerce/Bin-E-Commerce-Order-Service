// Entity này là aggregate root của Order Service.
// Các product, variant, shop và user ID chỉ là opaque reference; không tạo foreign key cross-service.
// Snapshot item và địa chỉ được lưu tại thời điểm checkout để lịch sử đơn không bị thay đổi theo dữ liệu hiện tại.

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { OrderStatus } from "../../modules/order/enums/order-status.enum";
import { PaymentMethod } from "../../modules/order/enums/payment-method.enum";
import { OrderItem } from "./order-item.entity";
import { OrderStatusHistory } from "./order-status-history.entity";

// Lưu một đơn hàng và khóa idempotency theo từng owner.
@Entity({ name: "orders" })
@Index("uq_orders_owner_idempotency_key", ["ownerId", "idempotencyKey"], {
  unique: true,
})
@Index("idx_orders_owner_created_at", ["ownerId", "createdAt"])
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_number", type: "varchar", length: 32, unique: true })
  orderNumber!: string;

  @Column({ name: "owner_id", type: "varchar", length: 255 })
  ownerId!: string;

  @Column({
    type: "enum",
    enum: OrderStatus,
    enumName: "order_status_enum",
    default: OrderStatus.CONFIRMED,
  })
  status!: OrderStatus;

  @Column({
    name: "payment_method",
    type: "enum",
    enum: PaymentMethod,
    enumName: "payment_method_enum",
  })
  paymentMethod!: PaymentMethod;

  @Column({ name: "shipping_address_id", type: "uuid" })
  shippingAddressId!: string;

  @Column({ name: "shipping_address", type: "jsonb" })
  shippingAddress!: Record<string, string>;

  @Column({ type: "numeric", precision: 14, scale: 2 })
  subtotal!: string;

  @Column({
    name: "shipping_fee",
    type: "numeric",
    precision: 14,
    scale: 2,
    default: 0,
  })
  shippingFee!: string;

  @Column({ name: "total_amount", type: "numeric", precision: 14, scale: 2 })
  totalAmount!: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  note!: string | null;

  @Column({
    name: "cancel_reason",
    type: "varchar",
    length: 500,
    nullable: true,
  })
  cancelReason!: string | null;

  @Column({ name: "cancelled_at", type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: "idempotency_key", type: "varchar", length: 128 })
  idempotencyKey!: string;

  @Column({ name: "request_fingerprint", type: "varchar", length: 700 })
  requestFingerprint!: string;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];

  @OneToMany(() => OrderStatusHistory, (history) => history.order, {
    cascade: true,
  })
  statusHistory!: OrderStatusHistory[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
