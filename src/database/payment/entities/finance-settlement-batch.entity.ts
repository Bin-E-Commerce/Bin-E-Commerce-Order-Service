// Đợt đối soát chỉ gom các giao dịch nền tảng để admin rà soát, không chặn ghi có vào ví seller.
import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('finance_settlement_batches')
export class FinanceSettlementBatch {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 32, default: 'OPEN' })
    status!: 'OPEN' | 'RECONCILED';

    @Column({ name: 'note', type: 'varchar', length: 500, nullable: true })
    note!: string | null;

    @Column({ name: 'created_by', type: 'varchar', length: 255 })
    createdBy!: string;

    @Column({
        name: 'reconciled_by',
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    reconciledBy!: string | null;

    @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
    reconciledAt!: Date | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
