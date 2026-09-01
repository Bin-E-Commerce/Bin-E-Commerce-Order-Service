// Query riêng cho Seller order list; search chỉ áp dụng trên mã đơn và pageSize luôn bị giới hạn server-side.

import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { OrderStatus } from "../../../database/order/enums/order-status.enum";
import { OrderFulfillmentStatus } from "../../../database/order/enums/order-fulfillment-status.enum";

export class SellerOrderListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize = 10;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(OrderFulfillmentStatus)
  stage?: OrderFulfillmentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}
