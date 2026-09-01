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
import { OrderStatus } from "../enums/order-status.enum";
import { OrderFulfillmentStatus } from "../enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../enums/payment-status.enum";
import { PaymentMethod } from "../enums/payment-method.enum";
import { OrderItem } from "./order-item.entity";
import { OrderStatusHistory } from "./order-status-history.entity";
import { OrderDeliveryConfirmationStatus } from "../../delivery/enums/order-delivery-confirmation-status.enum";
import { OrderDeliveryConfirmationMethod } from "../../delivery/enums/order-delivery-confirmation-method.enum";

// Lưu một đơn hàng và khóa idempotency theo từng owner.
@Entity({ name: "orders" })
@Index("uq_orders_owner_idempotency_key", ["ownerId", "idempotencyKey"], {
  unique: true,
})
@Index("idx_orders_owner_created_at", ["ownerId", "createdAt"])
@Index("idx_orders_delivery_confirmation_deadline", ["fulfillmentStatus", "deliveryConfirmationDeadline"])
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

  // Trạng thái fulfillment mới dùng cho UI Customer/Seller; status cũ được giữ để tương thích dữ liệu Phase 1-3.
  @Column({
    name: "fulfillment_status",
    type: "enum",
    enum: OrderFulfillmentStatus,
    enumName: "order_fulfillment_status_enum",
    default: OrderFulfillmentStatus.TO_SHIP,
  })
  fulfillmentStatus!: OrderFulfillmentStatus;

  @Column({ name: "delivery_confirmation_status", type: "enum", enum: OrderDeliveryConfirmationStatus, enumName: "order_delivery_confirmation_status_enum", default: OrderDeliveryConfirmationStatus.PENDING })
  deliveryConfirmationStatus!: OrderDeliveryConfirmationStatus;

  @Column({ name: "delivery_confirmation_method", type: "enum", enum: OrderDeliveryConfirmationMethod, enumName: "order_delivery_confirmation_method_enum", nullable: true })
  deliveryConfirmationMethod!: OrderDeliveryConfirmationMethod | null;

  @Column({ name: "delivered_at", type: "timestamptz", nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: "delivery_confirmation_deadline", type: "timestamptz", nullable: true })
  deliveryConfirmationDeadline!: Date | null;

  @Column({ name: "delivery_confirmed_at", type: "timestamptz", nullable: true })
  deliveryConfirmedAt!: Date | null;

  // COD chỉ được xem là PAID sau khi mô phỏng giao thành công và thu tiền.
  @Column({
    name: "payment_status",
    type: "enum",
    enum: PaymentStatus,
    enumName: "payment_status_enum",
    default: PaymentStatus.COD_PENDING_COLLECTION,
  })
  paymentStatus!: PaymentStatus;

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
  shippingAddress!: Record<string, unknown>;

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

  // Lưu breakdown quote tại thời điểm đặt để phí lịch sử không đổi theo provider hiện tại.
  @Column({
    name: "shipping_fee_breakdown",
    type: "jsonb",
    default: () => "'[]'::jsonb",
  })
  shippingFeeBreakdown!: Array<Record<string, unknown>>;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ name: "return_window_until", type: "timestamptz", nullable: true })
  returnWindowUntil!: Date | null;

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
