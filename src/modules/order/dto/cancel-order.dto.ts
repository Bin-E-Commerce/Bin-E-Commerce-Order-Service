import { IsOptional, IsString, MaxLength } from "class-validator";

// Lý do hủy là tùy chọn nhưng được giới hạn cùng chuẩn lưu trữ của order.
export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
