// File này cung cấp contract nội bộ cho Shipping Service.
// Route kiểm tra service token trước khi trả snapshot, không được expose qua browser/Gateway.

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrderCommandService } from "../services/order/order-command.service";
import { OrderReturnService } from "../services/returns/order-return.service";
import { UpdateReturnShippingCostDto } from "../dto/order-return.dto";
import { CancelOrderDto } from "../dto/cancel-order.dto";

@Controller({ path: "internal/orders", version: "1" })
export class InternalOrderController {
  constructor(
    private readonly orderCommandService: OrderCommandService,
    private readonly config: ConfigService,
    private readonly orderReturnService: OrderReturnService,
  ) {}

  // Trả snapshot item của shop sau khi Order Service tự kiểm tra order thuộc shop được truyền qua internal context.
  @Get(":orderId/shipping-context")
  getShippingContext(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Headers("x-user-id") sellerUserId: string,
    @Headers("x-shop-id") shopId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderCommandService.getShippingContext(
      orderId,
      sellerUserId,
      shopId,
    );
  }

  // Shipping Service gọi sau khi Seller hủy vận đơn; Order Service giữ quyền đổi trạng thái và hoàn tồn kho.
  @Post(":orderId/seller-cancel")
  async cancelBySeller(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Headers("x-user-id") sellerUserId: string,
    @Headers("x-shop-id") shopId: string,
    @Headers("x-internal-service-token") token: string,
    @Body() dto: CancelOrderDto,
  ) {
    this.assertInternalToken(token);
    return this.orderCommandService.cancelBySeller(
      sellerUserId,
      shopId,
      orderId,
      dto,
    );
  }

  // Shipping Service callback mở bước kiểm tra khi kiện hoàn đã về shop.
  @Post(":returnId/return-received")
  markReturnReceived(
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderReturnService.markReceived(returnId);
  }

  // Shipping Service dùng callback này sau khi đã commit reverse shipment local.
  @Post(":returnId/return-in-transit")
  markReturnInTransit(
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderReturnService.markInTransit(returnId);
  }

  // Trả snapshot chiều customer -> shop cho Shipping Service tạo reverse shipment.
  @Get("returns/:returnId/shipping-context")
  getReturnShippingContext(
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderReturnService.getShippingContext(returnId);
  }

  // Shipping Service ghi nhận chi phí reverse shipment thực tế sau khi GHN tạo vận đơn hoàn.
  @Post("returns/:returnId/return-shipping-cost")
  updateReturnShippingCost(
    @Param("returnId", new ParseUUIDPipe()) returnId: string,
    @Headers("x-internal-service-token") token: string,
    @Body() dto: UpdateReturnShippingCostDto,
  ) {
    this.assertInternalToken(token);
    return this.orderReturnService.updateReturnShippingCost(returnId, dto.amount);
  }

  // Chỉ trả acknowledgement để Shipping Service xác nhận customer ownership mà không nhận dữ liệu order dư thừa.
  @Get(":orderId/owner-check")
  async checkOwner(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Headers("x-user-id") ownerId: string,
    @Headers("x-internal-service-token") token: string,
  ): Promise<{ orderId: string }> {
    this.assertInternalToken(token);
    await this.orderCommandService.assertOwnedOrder(ownerId, orderId);
    return { orderId };
  }

  // Product Service dùng context này để xác minh người mua, item và thời hạn review mà không truy cập database Order.
  @Get("items/:orderItemId/review-context")
  getReviewContext(
    @Param("orderItemId", new ParseUUIDPipe()) orderItemId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderCommandService.getReviewContext(orderItemId);
  }

  // Product Service dùng endpoint này để dựng review status cho toàn bộ item sau khi Order Service xác minh owner.
  @Get(":orderId/review-context")
  getOrderReviewContext(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Headers("x-user-id") ownerId: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderCommandService.getOrderReviewContexts(ownerId, orderId);
  }

  // Product Service dùng endpoint này để đồng bộ lượt bán lịch sử theo đúng seller owner và product IDs.
  @Get("sales")
  getSoldQuantities(
    @Query("sellerOwnerId") sellerOwnerId: string,
    @Query("productIds") productIdsParam: string,
    @Headers("x-internal-service-token") token: string,
  ) {
    this.assertInternalToken(token);
    const productIds = [
      ...new Set(
        (productIdsParam ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    return this.orderCommandService.getSoldQuantities(
      sellerOwnerId,
      productIds,
    );
  }

  // Chặn truy cập trực tiếp từ bên ngoài bằng shared token của service mesh local.
  private assertInternalToken(token: string): void {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    if (!expected || token !== expected)
      throw new UnauthorizedException("Invalid internal service token.");
  }
}
