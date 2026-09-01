import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";
import { OrderStatus } from "../../../database/order/enums/order-status.enum";
import { OrderFulfillmentStatus } from "../../../database/order/enums/order-fulfillment-status.enum";

// Query danh sách order có giới hạn để bảo vệ database khỏi page size quá lớn.
export class OrderListQueryDto {
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
}
