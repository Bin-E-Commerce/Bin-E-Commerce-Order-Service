// Entity lưu yêu cầu return theo snapshot item ids, không tạo quan hệ cross-shop gây lộ dữ liệu.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { OrderReturnStatus } from "../enums/order-return-status.enum";

// Một request thuộc một customer order và một shop scope.
@Entity("order_return_requests")
@Index(["orderId", "shopId", "status"])
export class OrderReturnRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ name: "owner_id", type: "varchar", length: 255 })
  ownerId!: string;

  @Column({ name: "shop_id", type: "uuid" })
  shopId!: string;

  @Column({ name: "item_ids", type: "jsonb" })
  itemIds!: string[];

  @Column({
    type: "enum",
    enum: OrderReturnStatus,
    enumName: "order_return_status_enum",
    default: OrderReturnStatus.REQUESTED,
  })
  status!: OrderReturnStatus;

  @Column({ type: "varchar", length: 120 })
  reason!: string;

  @Column({ type: "varchar", length: 1000, nullable: true })
  description!: string | null;

  @Column({ name: "review_note", type: "varchar", length: 500, nullable: true })
  reviewNote!: string | null;

  @Column({ name: "requested_at", type: "timestamptz", default: () => "now()" })
  requestedAt!: Date;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
