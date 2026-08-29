// File này lưu audit trail trạng thái để lịch sử đơn có thể giải thích được về sau.

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { OrderStatus } from "../../modules/order/enums/order-status.enum";
import { Order } from "./order.entity";

// Mỗi lần đổi trạng thái tạo một bản ghi append-only thay vì ghi đè lịch sử.
@Entity({ name: "order_status_history" })
export class OrderStatusHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.statusHistory, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @Column({
    name: "from_status",
    type: "enum",
    enum: OrderStatus,
    enumName: "order_status_enum",
    nullable: true,
  })
  fromStatus!: OrderStatus | null;

  @Column({
    name: "to_status",
    type: "enum",
    enum: OrderStatus,
    enumName: "order_status_enum",
  })
  toStatus!: OrderStatus;

  @Column({ type: "varchar", length: 500 })
  reason!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
