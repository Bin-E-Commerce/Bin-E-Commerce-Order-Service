// Controller Seller order tách namespace khỏi customer order để route động của customer không nuốt path "seller".
// Controller chỉ đọc context header và giao authorization/business query cho application service.

import {
  Controller,
  Get,
  Body,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
  Post,
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
import { OrderCommandService } from "../services/order/order-command.service";
import { SellerOrderAccessService } from "../services/order/seller-order-access.service";
import { OrderReturnService } from "../services/returns/order-return.service";
import { InspectOrderReturnDto, ReviewOrderReturnDto } from "../dto/order-return.dto";
import { OrderReturnStatus } from "../../../database/returns/enums/order-return-status.enum";

@ApiTags("seller-orders")
@ApiBearerAuth()
@Controller({ path: "seller/orders", version: "1" })
export class SellerOrderController {
  // Controller giữ dependency mỏng để endpoint list/detail dùng chung policy trong application service.
  constructor(
    private readonly orderCommandService: OrderCommandService,
    private readonly sellerOrderAccess: SellerOrderAccessService,
    private readonly orderReturnService: OrderReturnService,
  ) {}

  // Seller queue return được lọc theo shop từ user context.
  @Get("returns")
  listReturns(@Headers() headers: Record<string, unknown>, @Query("status") status?: OrderReturnStatus) {
    return this.orderReturnService.listForSeller(this.sellerOrderAccess.buildCurrentUserFromHeaders(headers), status);
  }

  // List Seller chỉ gồm order có item thuộc shop được resolve từ user context.
  @Get()
  @ApiOperation({ summary: "List seller orders" })
  @ApiResponse({
    status: 200,
    description: "Paginated seller orders",
    type: Object,
  })
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
  @ApiResponse({
    status: 200,
    description: "Seller order detail",
    type: Object,
  })
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

  // Seller approve request return chỉ trong shop được resolve từ user context.
  @Post("returns/:returnId/approve")
  approveReturn(
    @Headers() headers: Record<string, unknown>,
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Body() dto: ReviewOrderReturnDto,
  ) {
    return this.orderReturnService.review(
      this.sellerOrderAccess.buildCurrentUserFromHeaders(headers),
      returnId,
      dto,
      OrderReturnStatus.APPROVED,
    );
  }

  // Seller reject request return với ghi chú tùy chọn để customer biết lý do.
  @Post("returns/:returnId/reject")
  rejectReturn(
    @Headers() headers: Record<string, unknown>,
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Body() dto: ReviewOrderReturnDto,
  ) {
    return this.orderReturnService.review(
      this.sellerOrderAccess.buildCurrentUserFromHeaders(headers),
      returnId,
      dto,
      OrderReturnStatus.REJECTED,
    );
  }

  // Seller ghi nhận kết quả kiểm tra kiện hàng đã nhận.
  @Post("returns/:returnId/inspection")
  inspectReturn(
    @Headers() headers: Record<string, unknown>,
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Body() dto: InspectOrderReturnDto,
  ) {
    return this.orderReturnService.inspect(this.sellerOrderAccess.buildCurrentUserFromHeaders(headers), returnId, dto);
  }
}
