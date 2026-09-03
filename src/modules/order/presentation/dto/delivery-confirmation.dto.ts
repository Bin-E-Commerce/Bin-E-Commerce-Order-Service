// File này xác thực payload customer dùng để xác nhận đã nhận hàng hoặc báo delivery issue.

import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { OrderDeliveryIssueReason } from "../../../../database/delivery/enums/order-delivery-issue-reason.enum";

export enum DeliveryConfirmationDecision {
  RECEIVED = "RECEIVED",
  ISSUE = "ISSUE",
}

// Evidence của delivery issue được lưu cùng issue để customer không phải gửi lại bằng chứng ở luồng khác.
export class DeliveryIssueEvidenceDto {
  @IsUUID("all")
  assetId!: string;

  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsIn(["image", "video"])
  type!: "image" | "video";
}

export class DeliveryConfirmationDto {
  @IsEnum(DeliveryConfirmationDecision)
  decision!: DeliveryConfirmationDecision;

  @ValidateIf((value: DeliveryConfirmationDto) => value.decision === DeliveryConfirmationDecision.ISSUE)
  @IsEnum(OrderDeliveryIssueReason)
  reason?: OrderDeliveryIssueReason;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("4", { each: true })
  itemIds?: string[];

  @ValidateIf((value: DeliveryConfirmationDto) => value.decision === DeliveryConfirmationDecision.ISSUE)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ValidateIf((value: DeliveryConfirmationDto) => value.decision === DeliveryConfirmationDecision.ISSUE)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => DeliveryIssueEvidenceDto)
  evidence?: DeliveryIssueEvidenceDto[];
}
