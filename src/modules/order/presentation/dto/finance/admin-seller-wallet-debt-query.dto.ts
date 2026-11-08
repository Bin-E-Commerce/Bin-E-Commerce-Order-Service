// DTO lọc danh sách công nợ admin; giới hạn trang và từ khóa trước khi chạm đến dữ liệu ví.
import { Transform, Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import type { AdminSellerWalletDebtFilter } from '@/modules/order/application/types/finance/seller-wallet-debt.type';

const ADMIN_SELLER_WALLET_DEBT_FILTERS: AdminSellerWalletDebtFilter[] = [
    'ALL',
    'DEBT',
    'OVERDUE',
    'LOCKED',
];

// Chỉ chấp nhận bộ lọc đã định nghĩa và chặn pageSize/page khỏi tạo truy vấn không giới hạn.
export class AdminSellerWalletDebtQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1_000_000)
    page = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize = 20;

    @IsOptional()
    @IsIn(ADMIN_SELLER_WALLET_DEBT_FILTERS)
    status: AdminSellerWalletDebtFilter = 'ALL';

    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Transform(({ value }) =>
        typeof value === 'string'
            ? value.trim().replace(/\s+/g, ' ').slice(0, 100)
            : value,
    )
    search?: string;
}
