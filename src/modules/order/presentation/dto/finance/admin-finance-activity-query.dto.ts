// Khoảng ngày báo cáo finance dùng ngày ISO thuần để SQL nhóm dữ liệu theo timezone nghiệp vụ Việt Nam.
import { IsDateString, Matches } from 'class-validator';

export class AdminFinanceActivityQueryDto {
    @IsDateString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    from!: string;

    @IsDateString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    to!: string;
}
