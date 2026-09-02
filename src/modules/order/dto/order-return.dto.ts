// DTO return giới hạn lý do/mô tả và item snapshot customer được phép yêu cầu.
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { OrderReturnReason } from "../../../database/returns/enums/order-return-reason.enum";

// Request tạo yêu cầu trả hàng cho các item thuộc order của customer.
export class CreateOrderReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  itemIds!: string[];

  @IsEnum(OrderReturnReason)
  reason!: OrderReturnReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ReturnEvidenceDto)
  evidence?: ReturnEvidenceDto[];
}

export class ReturnEvidenceDto {
  @IsUUID("all")
  assetId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url!: string;

  @IsIn(["image", "video"])
  type!: "image" | "video";
}

// Seller ghi chú khi approve/reject request.
export class ReviewOrderReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class InspectOrderReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ReturnEvidenceDto)
  evidence?: ReturnEvidenceDto[];

  @IsBoolean()
  passed!: boolean;
}

// Payload nội bộ nhận chi phí vận chuyển chiều ngược đã được Shipping Service lấy từ GHN.
export class UpdateReturnShippingCostDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;
}
