// Entity số dư theo shop; mọi thay đổi phải có ledger tương ứng trong cùng transaction.
import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

// Wallet chỉ lưu số dư kế toán nội bộ; không đại diện tiền đã chuyển ra ngân hàng.
@Entity('seller_wallets')
export class SellerWallet {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'shop_id', type: 'uuid', unique: true })
    shopId!: string;

    @Column({
        name: 'pending_balance',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    pendingBalance!: string;

    @Column({
        name: 'available_balance',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    availableBalance!: string;

    // Ngày đến hạn chỉ được tạo khi available balance lần đầu chuyển âm và được DB trigger giữ ổn định.
    @Column({ name: 'debt_due_at', type: 'timestamptz', nullable: true })
    debtDueAt!: Date | null;

    // Marker đã đồng bộ sang Seller Service; không phải số dư và không thay thế ledger.
    @Column({ name: 'finance_locked_at', type: 'timestamptz', nullable: true })
    financeLockedAt!: Date | null;

    @Column({
        name: 'reserved_balance',
        type: 'numeric',
        precision: 14,
        scale: 2,
        default: 0,
    })
    reservedBalance!: string;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
