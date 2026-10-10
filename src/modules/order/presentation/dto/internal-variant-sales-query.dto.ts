// DTO truy vấn nội bộ số lượng bán theo SKU/biến thể; giới hạn danh sách để request không tạo query quá lớn.
import { Transform } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsUUID,
} from 'class-validator';

export class InternalVariantSalesQueryDto {
    @Transform(({ value }) =>
        typeof value === 'string' ? value.split(',').map((id) => id.trim()) : value,
    )
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @IsUUID('4', { each: true })
    variantIds!: string[];

    @IsDateString()
    from!: string;

    @IsDateString()
    to!: string;
}
