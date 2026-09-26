import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { OrderPurchaseEvent } from '@common/kafka/events/order.events';

// Outbox giữ purchase event trong Order DB; trạng thái order và event được commit cùng transaction.
@Entity({ name: 'order_purchase_event_outbox' })
@Index('idx_order_purchase_event_outbox_pending', ['status', 'availableAt'])
export class OrderPurchaseEventOutboxEntity {
    @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 255 })
    eventId!: string;

    @Column({ name: 'topic', type: 'varchar', length: 128 })
    topic!: string;

    @Column({ name: 'aggregate_id', type: 'uuid' })
    aggregateId!: string;

    @Column({ name: 'payload', type: 'jsonb' })
    payload!: OrderPurchaseEvent;

    @Column({ name: 'status', type: 'varchar', length: 16, default: 'PENDING' })
    status!: 'PENDING' | 'PROCESSING' | 'PUBLISHED';

    @Column({ name: 'attempt_count', type: 'integer', default: 0 })
    attemptCount!: number;

    @Column({
        name: 'available_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    availableAt!: Date;

    @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
    publishedAt!: Date | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
    updatedAt!: Date;
}
