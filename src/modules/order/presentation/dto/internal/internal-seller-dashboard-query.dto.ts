// Query nội bộ cho Seller Service; toàn bộ mốc thời gian phải là ISO date đã được validate.

import { IsDateString, IsUUID } from 'class-validator';

export class InternalSellerDashboardQueryDto {
    @IsUUID()
    shopId!: string;

    @IsDateString()
    from!: string;

    @IsDateString()
    to!: string;

    @IsDateString()
    previousFrom!: string;

    @IsDateString()
    previousTo!: string;
}
