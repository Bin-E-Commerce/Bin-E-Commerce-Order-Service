// Controller này công bố API checkout và chi tiết order cho Gateway.
// Controller chỉ đọc header context, validate route parameter và gọi application service.
// Ownership luôn lấy từ x-user-id do Gateway inject, không nhận ownerId từ body hoặc query.

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CreateCodOrderDto } from "../dto/create-cod-order.dto";
import { CancelOrderDto } from "../dto/cancel-order.dto";
import { OrderListQueryDto } from "../dto/order-list-query.dto";
import type {
  OrderListResponse,
  OrderResponse,
} from "../types/order-response.type";
import { OrderCommandService } from "../services/order-command.service";

// Endpoint public của service được Gateway bảo vệ bằng JWT và permission order.create.
@ApiTags("orders")
@ApiBearerAuth()
@Controller({ path: "orders", version: "1" })
export class OrderController {
  constructor(private readonly orderCommandService: OrderCommandService) {}

  // Tạo COD order từ active cart hiện tại, hỗ trợ retry an toàn qua Idempotency-Key.
  @Post()
  @ApiOperation({ summary: "Create a COD order from the active cart" })
  @ApiResponse({ status: 201, description: "COD order created", type: Object })
  @ApiResponse({ status: 409, description: "Stock or idempotency conflict" })
  async createCodOrder(
    @Headers("x-user-id") ownerId: string,
    @Headers("x-user-email") ownerEmail: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string,
    @Body() dto: CreateCodOrderDto,
  ): Promise<OrderResponse> {
    return this.orderCommandService.createCodOrder(
      ownerId,
      dto,
      idempotencyKey,
      ownerEmail,
    );
  }

  // Trả lịch sử order của chính user từ x-user-id do Gateway inject.
  @Get()
  @ApiOperation({ summary: "List owned orders" })
  @ApiResponse({
    status: 200,
    description: "Paginated order summaries",
    type: Object,
  })
  listOwnedOrders(
    @Headers("x-user-id") ownerId: string,
    @Query() query: OrderListQueryDto,
  ): Promise<OrderListResponse> {
    return this.orderCommandService.listOwnedOrders(ownerId, query);
  }

  // Trả chi tiết order sau khi redirect từ checkout, có ownership filter ở repository.
  @Get(":orderId")
  @ApiOperation({ summary: "Get an owned order" })
  @ApiResponse({ status: 200, description: "Order detail", type: Object })
  @ApiResponse({ status: 404, description: "Order not found" })
  getOwnedOrder(
    @Headers("x-user-id") ownerId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<OrderResponse> {
    return this.orderCommandService.getOwnedOrder(ownerId, orderId);
  }

  // Hủy order COD đã xác nhận; service sẽ release tồn kho trước khi đổi trạng thái.
  @Post(":orderId/cancel")
  @ApiOperation({ summary: "Cancel an owned COD order" })
  @ApiResponse({ status: 200, description: "Order cancelled", type: Object })
  @ApiResponse({ status: 409, description: "Order cannot be cancelled" })
  @ApiResponse({ status: 503, description: "Inventory service unavailable" })
  cancelOwnedOrder(
    @Headers("x-user-id") ownerId: string,
    @Headers("x-user-email") ownerEmail: string | undefined,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() dto: CancelOrderDto,
  ): Promise<OrderResponse> {
    return this.orderCommandService.cancelOwnedOrder(
      ownerId,
      orderId,
      dto,
      ownerEmail,
    );
  }
}
