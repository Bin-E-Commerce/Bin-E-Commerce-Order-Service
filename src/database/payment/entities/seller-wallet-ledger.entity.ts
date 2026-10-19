// Ledger bất biến cho mọi khoản ghi nhận, giải phóng hoặc điều chỉnh ví seller.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

// Khóa nguồn duy nhất đảm bảo callback, job hoặc retry không ghi một khoản tiền lần hai.
@Entity('seller_wallet_ledger')
@Index('uq_seller_wallet_ledger_source_key', ['sourceKey'], { unique: true })
@Index('idx_seller_wallet_ledger_shop_created', ['shopId', 'createdAt'])
export class SellerWalletLedger {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'shop_id', type: 'uuid' })
    shopId!: string;

    @Column({ name: 'order_id', type: 'uuid', nullable: true })
    orderId!: string | null;

    @Column({ name: 'return_request_id', type: 'uuid', nullable: true })
    returnRequestId!: string | null;

    @Column({ type: 'varchar', length: 32 })
    kind!:
        | 'SALE_PENDING'
        | 'RELEASE_AVAILABLE'
        | 'REFUND_PENDING_REVERSAL'
        | 'REFUND_AVAILABLE_REVERSAL'
        | 'WALLET_DEPOSIT'
        | 'WITHDRAWAL_RESERVED'
        | 'WITHDRAWAL_PAID'
        | 'WITHDRAWAL_RELEASED'
        | 'RETURN_SHIPPING_DEBIT';

    @Column({ type: 'numeric', precision: 14, scale: 2 })
    amount!: string;

    @Column({ name: 'source_key', type: 'varchar', length: 160 })
    sourceKey!: string;

    @Column({ name: 'available_at', type: 'timestamptz', nullable: true })
    availableAt!: Date | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
