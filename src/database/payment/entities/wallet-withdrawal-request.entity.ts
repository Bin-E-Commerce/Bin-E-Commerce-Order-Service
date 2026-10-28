// Yêu cầu rút tiền giữ snapshot tài khoản nhận và audit admin; chỉ xác nhận PAID mới chốt trừ ví.
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity('wallet_withdrawal_requests')
@Index('idx_wallet_withdrawals_shop_created', ['shopId', 'createdAt'])
@Index('idx_wallet_withdrawals_status_created', ['status', 'createdAt'])
export class WalletWithdrawalRequest {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'shop_id', type: 'uuid' })
    shopId!: string;

    @Column({ name: 'seller_user_id', type: 'varchar', length: 255 })
    sellerUserId!: string;

    @Column({ type: 'numeric', precision: 14, scale: 2 })
    amount!: string;

    @Column({ name: 'bank_code', type: 'varchar', length: 40 })
    bankCode!: string;

    @Column({ name: 'bank_name', type: 'varchar', length: 120 })
    bankName!: string;

    @Column({ name: 'account_holder', type: 'varchar', length: 160 })
    accountHolder!: string;

    @Column({
        name: 'account_number',
        type: 'varchar',
        length: 40,
        select: false,
    })
    accountNumber!: string;

    @Column({ name: 'account_number_masked', type: 'varchar', length: 40 })
    accountNumberMasked!: string;

    @Column({
        name: 'transfer_memo_code',
        type: 'varchar',
        length: 23,
        nullable: true,
    })
    transferMemoCode!: string | null;

    @Column({ type: 'varchar', length: 24, default: 'REQUESTED' })
    status!: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'REJECTED' | 'FAILED';

    @Column({
        name: 'transfer_reference',
        type: 'varchar',
        length: 120,
        nullable: true,
    })
    transferReference!: string | null;

    @Column({
        name: 'admin_note',
        type: 'varchar',
        length: 500,
        nullable: true,
    })
    adminNote!: string | null;

    @Column({
        name: 'processed_by',
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    processedBy!: string | null;

    @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
    processedAt!: Date | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
