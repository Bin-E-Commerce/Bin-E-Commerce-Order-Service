// DTO nội bộ lưu lý do carrier từ chối hoặc hủy vận đơn hoàn để seller có thể sửa và retry.
import { IsString, MaxLength, MinLength } from 'class-validator';

// Loại chuỗi rỗng/không gian trước khi lý do được ghi vào return request và notification.
export class ReturnShipmentFailedDto {
    @IsString()
    @MinLength(3)
    @MaxLength(500)
    note!: string;
}
