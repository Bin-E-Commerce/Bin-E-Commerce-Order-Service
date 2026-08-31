// DTO return giới hạn lý do/mô tả và item snapshot customer được phép yêu cầu.
import { ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

// Request tạo yêu cầu trả hàng cho các item thuộc order của customer.
export class CreateOrderReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  itemIds!: string[];

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

// Seller ghi chú khi approve/reject request.
export class ReviewOrderReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
