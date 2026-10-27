// Sổ tiền nền tảng mô phỏng các khoản vào/ra; không đại diện số dư ngân hàng thật hoặc lệnh chuyển tiền tự động.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('platform_finance_ledger')
@Index('uq_platform_finance_ledger_source_key', ['sourceKey'], { unique: true })
@Index('idx_platform_finance_ledger_created', ['createdAt'])
export class PlatformFinanceLedger {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 40 })
    kind!:
        | 'ORDER_PAYMENT'
        | 'WALLET_DEPOSIT'
        | 'COD_REMITTANCE'
        | 'PAY2S_REFUND_MANUAL'
        | 'COD_REFUND'
        | 'SELLER_PAYOUT'
        | 'RETURN_SHIPPING_FEE'
        | 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE'
        | 'SHIPPING_FUND_ALLOCATION'
        | 'SHIPPING_FUND_REFUND';

    @Column({ type: 'numeric', precision: 14, scale: 2 })
    amount!: string;

    @Column({ name: 'source_key', type: 'varchar', length: 180 })
    sourceKey!: string;

    @Column({ name: 'shop_id', type: 'uuid', nullable: true })
    shopId!: string | null;

    @Column({ name: 'order_id', type: 'uuid', nullable: true })
    orderId!: string | null;

    @Column({ name: 'return_request_id', type: 'uuid', nullable: true })
    returnRequestId!: string | null;

    @Column({ name: 'reference', type: 'varchar', length: 120, nullable: true })
    reference!: string | null;

    @Column({ name: 'settlement_batch_id', type: 'uuid', nullable: true })
    settlementBatchId!: string | null;

    @Column({
        name: 'created_by',
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    createdBy!: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
