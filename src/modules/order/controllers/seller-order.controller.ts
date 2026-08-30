// Controller Seller order tách namespace khỏi customer order để route động của customer không nuốt path "seller".
// Controller chỉ đọc context header và giao authorization/business query cho application service.

import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { SellerOrderListQueryDto } from "../dto/seller-order-list-query.dto";
import type {
  SellerOrderListResponse,
  SellerOrderResponse,
} from "../types/order-response.type";
import { OrderCommandService } from "../services/order-command.service";
import { SellerOrderAccessService } from "../services/seller-order-access.service";

@ApiTags("seller-orders")
@ApiBearerAuth()
@Controller({ path: "seller/orders", version: "1" })
export class SellerOrderController {
  // Controller giữ dependency mỏng để endpoint list/detail dùng chung policy trong application service.
  constructor(
    private readonly orderCommandService: OrderCommandService,
    private readonly sellerOrderAccess: SellerOrderAccessService,
  ) {}

  // List Seller chỉ gồm order có item thuộc shop được resolve từ user context.
  @Get()
  @ApiOperation({ summary: "List seller orders" })
  @ApiResponse({ status: 200, description: "Paginated seller orders", type: Object })
  listSellerOrders(
    @Headers() headers: Record<string, unknown>,
    @Query() query: SellerOrderListQueryDto,
  ): Promise<SellerOrderListResponse> {
    return this.orderCommandService.listSellerOrders(
      this.sellerOrderAccess.buildCurrentUserFromHeaders(headers),
      query,
    );
  }

  // Detail Seller không trả order nếu shop hiện tại không có item trong order đó.
  @Get(":orderId")
  @ApiOperation({ summary: "Get a seller order" })
  @ApiResponse({ status: 200, description: "Seller order detail", type: Object })
  @ApiResponse({ status: 404, description: "Order not found for this shop" })
  getSellerOrder(
    @Headers() headers: Record<string, unknown>,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<SellerOrderResponse> {
    return this.orderCommandService.getSellerOrder(
      this.sellerOrderAccess.buildCurrentUserFromHeaders(headers),
      orderId,
    );
  }
}
