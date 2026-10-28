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
@Index('uq_wallet_withdrawals_pay2s_transaction_id', ['pay2sTransactionId'], {
    unique: true,
    where: '"pay2s_transaction_id" IS NOT NULL',
})
@Index('uq_wallet_withdrawals_transfer_memo_code', ['transferMemoCode'], {
    unique: true,
    where: '"transfer_memo_code" IS NOT NULL',
})
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
        name: 'pay2s_transaction_id',
        type: 'varchar',
        length: 120,
        nullable: true,
    })
    pay2sTransactionId!: string | null;

    @Column({
        name: 'pay2s_transaction_number',
        type: 'varchar',
        length: 120,
        nullable: true,
    })
    pay2sTransactionNumber!: string | null;

    @Column({
        name: 'pay2s_transfer_amount',
        type: 'numeric',
        precision: 14,
        scale: 2,
        nullable: true,
    })
    pay2sTransferAmount!: string | null;

    @Column({
        name: 'pay2s_transfer_detected_at',
        type: 'timestamptz',
        nullable: true,
    })
    pay2sTransferDetectedAt!: Date | null;

    @Column({
        name: 'recipient_confirmed_by',
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    recipientConfirmedBy!: string | null;

    @Column({
        name: 'recipient_confirmed_at',
        type: 'timestamptz',
        nullable: true,
    })
    recipientConfirmedAt!: Date | null;

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
