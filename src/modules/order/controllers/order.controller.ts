// Controller này công bố checkout, quote và order API; ownership luôn lấy từ x-user-id do Gateway xác thực.
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CancelOrderDto } from "../dto/cancel-order.dto";
import { CreateCodOrderDto } from "../dto/create-cod-order.dto";
import { CreateOrderQuoteDto } from "../dto/create-order-quote.dto";
import { CreateOrderReturnDto } from "../dto/order-return.dto";
import { OrderListQueryDto } from "../dto/order-list-query.dto";
import { OrderCommandService } from "../services/order/order-command.service";
import { OrderReturnService } from "../services/returns/order-return.service";
import { OrderDeliveryConfirmationService } from "../services/delivery/order-delivery-confirmation.service";
import { DeliveryConfirmationDto } from "../dto/delivery-confirmation.dto";
import type { OrderListResponse, OrderResponse } from "../types/order-response.type";

// Public Order API được Gateway bảo vệ bằng JWT và permission tương ứng.
@ApiTags("orders")
@ApiBearerAuth()
@Controller({ path: "orders", version: "1" })
export class OrderController {
  constructor(
    private readonly orderCommandService: OrderCommandService,
    private readonly orderReturnService: OrderReturnService,
    private readonly deliveryConfirmationService: OrderDeliveryConfirmationService,
  ) {}

  // Customer xác nhận đã nhận hàng hoặc báo vấn đề; Order Service giữ ownership và trạng thái trong một transaction duy nhất.
  @Post(":orderId/delivery-confirmation")
  confirmDelivery(
    @Headers("x-user-id") ownerId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body() dto: DeliveryConfirmationDto,
  ): Promise<OrderResponse> {
    return this.deliveryConfirmationService.confirm(ownerId, orderId, dto);
  }

  // Tính phí trước checkout từ cart/address server-side, không nhận item hoặc coupon từ browser.
  @Post("quote")
  quote(@Headers("x-user-id") ownerId: string, @Body() dto: CreateOrderQuoteDto) {
    return this.orderCommandService.quoteOrder(ownerId, dto.shippingAddressId, dto.paymentMethod);
  }

  // Tạo order COD idempotent từ cart đang hoạt động.
  @Post()
  @ApiOperation({ summary: "Create a COD order from the active cart" })
  @ApiResponse({ status: 201, description: "COD order created", type: Object })
  createCodOrder(@Headers("x-user-id") ownerId: string, @Headers("x-user-email") ownerEmail: string | undefined, @Headers("idempotency-key") idempotencyKey: string, @Body() dto: CreateCodOrderDto): Promise<OrderResponse> {
    return this.orderCommandService.createCodOrder(ownerId, dto, idempotencyKey, ownerEmail);
  }

  // Customer gửi yêu cầu return cho item của chính order, service kiểm tra thời hạn và ownership.
  @Post(":orderId/returns")
  createReturn(@Headers("x-user-id") ownerId: string, @Param("orderId", new ParseUUIDPipe()) orderId: string, @Body() dto: CreateOrderReturnDto) {
    return this.orderReturnService.create(ownerId, orderId, dto);
  }

  // Customer xem lịch sử return request thuộc order của mình.
  @Get(":orderId/returns")
  listReturns(@Headers("x-user-id") ownerId: string, @Param("orderId", new ParseUUIDPipe()) orderId: string) {
    return this.orderReturnService.list(ownerId, orderId);
  }

  // Trả lịch sử order thuộc owner hiện tại theo stage/status và pagination.
  @Get()
  @ApiOperation({ summary: "List owned orders" })
  listOwnedOrders(@Headers("x-user-id") ownerId: string, @Query() query: OrderListQueryDto): Promise<OrderListResponse> {
    return this.orderCommandService.listOwnedOrders(ownerId, query);
  }

  // Trả detail chỉ khi order thuộc owner hiện tại.
  @Get(":orderId")
  @ApiOperation({ summary: "Get an owned order" })
  getOwnedOrder(@Headers("x-user-id") ownerId: string, @Param("orderId", new ParseUUIDPipe()) orderId: string): Promise<OrderResponse> {
    return this.orderCommandService.getOwnedOrder(ownerId, orderId);
  }

  // Hủy order COD trước khi shipment được lấy hàng và release reservation.
  @Post(":orderId/cancel")
  cancelOwnedOrder(@Headers("x-user-id") ownerId: string, @Headers("x-user-email") ownerEmail: string | undefined, @Param("orderId", new ParseUUIDPipe()) orderId: string, @Body() dto: CancelOrderDto): Promise<OrderResponse> {
    return this.orderCommandService.cancelOwnedOrder(ownerId, orderId, dto, ownerEmail);
  }
}
