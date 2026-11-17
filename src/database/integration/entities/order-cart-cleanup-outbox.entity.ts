// Outbox lưu selection và mode cleanup cùng order để retry an toàn sau lỗi mạng hoặc restart Order Service.
// Cart Service dùng orderId làm khóa idempotency và chỉ đóng full cart legacy khi mốc thời gian còn hợp lệ.

import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { CartCheckoutItemSelection } from '@/modules/order/application/types/order/external-contracts.type';

// Mỗi order chỉ tạo một công việc cleanup; trạng thái PROCESSING có lease để worker khác nhận lại khi pod chết.
@Entity({ name: 'order_cart_cleanup_outbox' })
@Index('idx_order_cart_cleanup_outbox_retry', ['status', 'availableAt'])
export class OrderCartCleanupOutboxEntity {
    @PrimaryColumn({ name: 'order_id', type: 'uuid' })
    orderId!: string;

    @Column({ name: 'owner_id', type: 'varchar', length: 255 })
    ownerId!: string;

    @Column({ type: 'jsonb' })
    items!: CartCheckoutItemSelection[];

    @Column({
        name: 'cleanup_mode',
        type: 'varchar',
        length: 24,
        default: 'SNAPSHOT',
    })
    cleanupMode!: 'SNAPSHOT' | 'LEGACY_ITEM_IDS' | 'LEGACY_FULL_CART';

    @Column({ name: 'cleanup_before', type: 'timestamptz', nullable: true })
    cleanupBefore!: Date | null;

    @Column({ type: 'varchar', length: 16, default: 'PENDING' })
    status!: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ABANDONED';

    @Column({ name: 'attempt_count', type: 'integer', default: 0 })
    attemptCount!: number;

    @Column({
        name: 'available_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    availableAt!: Date;

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError!: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
