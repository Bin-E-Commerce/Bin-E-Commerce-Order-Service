// DTO lưu lý do giao dịch hoàn tiền thủ công thất bại để admin có thể retry từ cùng hàng đợi.
import { IsString, MaxLength, MinLength } from 'class-validator';

// Không cho chuyển trạng thái lỗi nếu admin chưa mô tả điều kiện cần khắc phục.
export class MarkRefundFailedDto {
    @IsString()
    @MinLength(10)
    @MaxLength(500)
    note!: string;
}
