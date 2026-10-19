// Giao dịch nạp ví độc lập với PaymentAttempt của đơn hàng, có merchant reference riêng và IPN idempotent.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('wallet_deposits')
@Index('uq_wallet_deposits_merchant_reference', ['merchantReference'], {
    unique: true,
})
@Index('uq_wallet_deposits_provider_transaction', ['providerTransactionId'], {
    unique: true,
    where: '"provider_transaction_id" IS NOT NULL',
})
@Index('idx_wallet_deposits_shop_created', ['shopId', 'createdAt'])
export class WalletDeposit {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'shop_id', type: 'uuid' })
    shopId!: string;

    @Column({ name: 'seller_user_id', type: 'varchar', length: 255 })
    sellerUserId!: string;

    @Column({ name: 'merchant_reference', type: 'varchar', length: 64 })
    merchantReference!: string;

    @Column({
        name: 'provider_transaction_id',
        type: 'varchar',
        length: 64,
        nullable: true,
    })
    providerTransactionId!: string | null;

    @Column({ type: 'varchar', length: 20, default: 'PENDING' })
    status!: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

    @Column({ type: 'varchar', length: 20, default: 'SANDBOX' })
    environment!: 'SANDBOX';

    @Column({ type: 'numeric', precision: 14, scale: 2 })
    amount!: string;

    @Column({ name: 'expires_at', type: 'timestamptz' })
    expiresAt!: Date;

    @Column({
        name: 'provider_response',
        type: 'jsonb',
        nullable: true,
        select: false,
    })
    providerResponse!: Record<string, unknown> | null;

    @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
    confirmedAt!: Date | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
