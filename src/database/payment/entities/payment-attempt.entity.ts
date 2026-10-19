// Entity lưu từng lần thanh toán VNPay; không giữ thông tin thẻ và không coi return URL là bằng chứng thanh toán.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

// Một attempt là snapshot bất biến của số tiền, provider reference và môi trường khi bắt đầu checkout.
@Entity('payment_attempts')
@Index('uq_payment_attempts_merchant_reference', ['merchantReference'], {
    unique: true,
})
@Index('uq_payment_attempts_provider_transaction', ['providerTransactionId'], {
    unique: true,
    where: '"provider_transaction_id" IS NOT NULL',
})
@Index('idx_payment_attempts_order_status', ['orderId', 'status'])
@Index('uq_payment_attempts_pending_order', ['orderId'], {
    unique: true,
    where: '"status" = \'PENDING\'',
})
export class PaymentAttempt {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'order_id', type: 'uuid' })
    orderId!: string;

    @Column({ name: 'merchant_reference', type: 'varchar', length: 64 })
    merchantReference!: string;

    @Column({
        name: 'provider_transaction_id',
        type: 'varchar',
        length: 64,
        nullable: true,
    })
    providerTransactionId!: string | null;

    @Column({
        name: 'refund_request_id',
        type: 'varchar',
        length: 32,
        nullable: true,
    })
    refundRequestId!: string | null;

    @Column({ type: 'varchar', length: 20, default: 'PENDING' })
    status!:
        | 'PENDING'
        | 'PAID'
        | 'FAILED'
        | 'EXPIRED'
        | 'REFUND_PENDING'
        | 'REFUNDED';

    @Column({ type: 'varchar', length: 20, default: 'LIVE' })
    environment!: 'LIVE' | 'SANDBOX';

    @Column({ type: 'numeric', precision: 14, scale: 2 })
    amount!: string;

    @Column({ type: 'char', length: 3, default: 'VND' })
    currency!: string;

    @Column({ name: 'expires_at', type: 'timestamptz' })
    expiresAt!: Date;

    @Column({ name: 'provider_create_date', type: 'char', length: 14 })
    providerCreateDate!: string;

    @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
    confirmedAt!: Date | null;

    @Column({
        name: 'provider_response',
        type: 'jsonb',
        nullable: true,
        select: false,
    })
    providerResponse!: Record<string, unknown> | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
