// File này xác thực payload customer dùng để xác nhận đã nhận hàng hoặc báo delivery issue.

import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { OrderDeliveryIssueReason } from "../../../database/delivery/enums/order-delivery-issue-reason.enum";

export enum DeliveryConfirmationDecision {
  RECEIVED = "RECEIVED",
  ISSUE = "ISSUE",
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
}
