// Entity lưu yêu cầu return theo snapshot item ids, không tạo quan hệ cross-shop gây lộ dữ liệu.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';

// Một request thuộc một customer order và một shop scope.
@Entity('order_return_requests')
@Index(['orderId', 'shopId', 'status'])
@Index('uq_order_return_refund_request_id', ['refundRequestId'], {
    unique: true,
    where: '"refund_request_id" IS NOT NULL',
})
@Index('uq_order_return_active_order_shop', ['orderId', 'shopId'], {
    unique: true,
    where: `"status" IN ('REQUESTED', 'AWAITING_SHIPMENT', 'IN_TRANSIT', 'SHIPMENT_FAILED', 'RECEIVED', 'REFUND_PENDING')`,
})
export class OrderReturnRequest {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'order_id', type: 'uuid' })
    orderId!: string;

    @Column({ name: 'owner_id', type: 'varchar', length: 255 })
    ownerId!: string;

    @Column({ name: 'shop_id', type: 'uuid' })
    shopId!: string;

    @Column({ name: 'item_ids', type: 'jsonb' })
    itemIds!: string[];

    @Column({
        type: 'enum',
        enum: OrderReturnStatus,
        enumName: 'order_return_status_enum',
        default: OrderReturnStatus.REQUESTED,
    })
    status!: OrderReturnStatus;

    @Column({ type: 'varchar', length: 120 })
    reason!: OrderReturnReason;

    @Column({ type: 'varchar', length: 1000, nullable: true })
    description!: string | null;

    @Column({
        name: 'review_note',
        type: 'varchar',
        length: 500,
        nullable: true,
    })
    reviewNote!: string | null;

    @Column({ name: 'evidence', type: 'jsonb', default: () => "'[]'::jsonb" })
    evidence!: Array<{ assetId: string; url: string; type: 'image' | 'video' }>;

    @Column({
        name: 'refund_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    refundAmount!: string;

    @Column({
        name: 'estimated_refund_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    estimatedRefundAmount!: string;

    @Column({
        name: 'refund_item_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    refundItemAmount!: string;

    @Column({
        name: 'refund_shipping_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    refundShippingAmount!: string;

    @Column({
        name: 'return_shipping_fee',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    returnShippingFee!: string;

    @Column({
        name: 'return_shipping_estimated_cost',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    returnShippingEstimatedCost!: string;

    @Column({
        name: 'return_shipping_cost',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    returnShippingCost!: string;

    @Column({
        name: 'return_shipping_payer',
        type: 'varchar',
        length: 16,
        nullable: true,
    })
    returnShippingPayer!: 'CUSTOMER' | 'SELLER' | null;

    @Column({
        name: 'return_shipping_finalized_at',
        type: 'timestamptz',
        nullable: true,
    })
    returnShippingFinalizedAt!: Date | null;

    @Column({
        name: 'customer_return_shipping_receivable_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    customerReturnShippingReceivableAmount!: string;

    @Column({ name: 'seller_user_id', type: 'uuid', nullable: true })
    sellerUserId!: string | null;

    @Column({ name: 'inspection_passed', type: 'boolean', nullable: true })
    inspectionPassed!: boolean | null;

    @Column({
        name: 'inspection_note',
        type: 'varchar',
        length: 1000,
        nullable: true,
    })
    inspectionNote!: string | null;

    @Column({ name: 'inspected_at', type: 'timestamptz', nullable: true })
    inspectedAt!: Date | null;

    @Column({
        name: 'refund_method',
        type: 'varchar',
        length: 40,
        nullable: true,
    })
    refundMethod!: 'VNPAY' | 'COD_MANUAL' | null;

    @Column({
        name: 'refund_request_id',
        type: 'varchar',
        length: 32,
        nullable: true,
    })
    refundRequestId!: string | null;

    @Column({
        name: 'refund_transaction_reference',
        type: 'varchar',
        length: 180,
        nullable: true,
    })
    refundTransactionReference!: string | null;

    @Column({ name: 'refund_proof', type: 'jsonb', nullable: true })
    refundProof!: Record<string, unknown> | null;

    @Column({
        name: 'refund_processed_by',
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    refundProcessedBy!: string | null;

    @Column({
        name: 'refund_processed_at',
        type: 'timestamptz',
        nullable: true,
    })
    refundProcessedAt!: Date | null;

    @Column({
        name: 'requested_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    requestedAt!: Date;

    @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
    reviewedAt!: Date | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
