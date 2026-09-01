// File này lưu delivery issue độc lập với order aggregate để giữ lịch sử khiếu nại và liên kết tùy chọn tới return request.
// Entity không tự quyết định quyền; mọi thay đổi issue phải đi qua application service đã kiểm tra owner hoặc shop scope.

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { OrderDeliveryIssueReason } from "../enums/order-delivery-issue-reason.enum";
import { OrderDeliveryIssueStatus } from "../enums/order-delivery-issue-status.enum";

@Entity({ name: "order_delivery_issues" })
@Index(["orderId", "status"])
export class OrderDeliveryIssue {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ name: "owner_id", type: "varchar", length: 255 })
  ownerId!: string;

  @Column({
    type: "enum",
    enum: OrderDeliveryIssueReason,
    enumName: "order_delivery_issue_reason_enum",
  })
  reason!: OrderDeliveryIssueReason;

  @Column({ name: "item_ids", type: "jsonb", default: () => "'[]'::jsonb" })
  itemIds!: string[];

  @Column({ type: "varchar", length: 1000, nullable: true })
  note!: string | null;

  @Column({
    type: "enum",
    enum: OrderDeliveryIssueStatus,
    enumName: "order_delivery_issue_status_enum",
    default: OrderDeliveryIssueStatus.OPEN,
  })
  status!: OrderDeliveryIssueStatus;

  @Column({ name: "return_request_id", type: "uuid", nullable: true })
  returnRequestId!: string | null;

  @Column({ name: "resolved_at", type: "timestamptz", nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: "resolution_note", type: "varchar", length: 500, nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
