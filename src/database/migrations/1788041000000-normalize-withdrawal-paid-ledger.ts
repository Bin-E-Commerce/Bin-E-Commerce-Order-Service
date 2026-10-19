import { MigrationInterface, QueryRunner } from 'typeorm';

// Seller wallet ledger mô tả biến động số dư ví; khoản chi thật được ghi riêng ở platform_finance_ledger.
export class NormalizeWithdrawalPaidLedger1788041000000
    implements MigrationInterface
{
    name = 'NormalizeWithdrawalPaidLedger1788041000000';

    // WITHDRAWAL_RESERVED đã trừ available; PAID chỉ tất toán reserved nên không được trừ seller ledger lần nữa.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "seller_wallet_ledger"
            SET "amount" = 0
            WHERE "kind" = 'WITHDRAWAL_PAID'
        `);
    }

    // Không thể khôi phục giá trị âm cũ mà không tái tạo từ từng withdrawal request; giữ ledger đã chuẩn hóa an toàn hơn.
    public async down(): Promise<void> {}
}
