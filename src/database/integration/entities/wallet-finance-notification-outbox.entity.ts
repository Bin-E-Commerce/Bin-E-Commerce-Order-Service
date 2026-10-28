// Outbox giữ sự kiện ví seller sau commit để Notification Service vẫn nhận được khi Kafka gián đoạn.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { WalletFinanceChangedEvent } from '@common/kafka/events';

@Entity({ name: 'wallet_finance_notification_outbox' })
@Index('idx_wallet_finance_notification_outbox_pending', [
    'status',
    'availableAt',
    'createdAt',
])
export class WalletFinanceNotificationOutboxEntity {
    @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 255 })
    eventId!: string;

    @Column({ type: 'varchar', length: 128 })
    topic!: string;

    @Column({ name: 'aggregate_id', type: 'uuid' })
    aggregateId!: string;

    @Column({ type: 'jsonb' })
    payload!: WalletFinanceChangedEvent;

    @Column({ type: 'varchar', length: 16, default: 'PENDING' })
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

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
