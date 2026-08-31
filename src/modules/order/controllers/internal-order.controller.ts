//
// File này cung cấp contract nội bộ cho Shipping Service.
// Route kiểm tra service token trước khi trả snapshot, không được expose qua browser/Gateway.
//

import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderCommandService } from '../services/order-command.service';

@Controller({ path: 'internal/orders', version: '1' })
export class InternalOrderController {
  constructor(
    private readonly orderCommandService: OrderCommandService,
    private readonly config: ConfigService,
  ) {}

  // Trả snapshot item của shop sau khi Order Service tự kiểm tra order thuộc shop được truyền qua internal context.
  @Get(':orderId/shipping-context')
  getShippingContext(
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Headers('x-user-id') sellerUserId: string,
    @Headers('x-shop-id') shopId: string,
    @Headers('x-internal-service-token') token: string,
  ) {
    this.assertInternalToken(token);
    return this.orderCommandService.getShippingContext(orderId, sellerUserId, shopId);
  }

  // Chỉ trả acknowledgement để Shipping Service xác nhận customer ownership mà không nhận dữ liệu order dư thừa.
  @Get(':orderId/owner-check')
  async checkOwner(
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Headers('x-user-id') ownerId: string,
    @Headers('x-internal-service-token') token: string,
  ): Promise<{ orderId: string }> {
    this.assertInternalToken(token);
    await this.orderCommandService.assertOwnedOrder(ownerId, orderId);
    return { orderId };
  }

  // Chặn truy cập trực tiếp từ bên ngoài bằng shared token của service mesh local.
  private assertInternalToken(token: string): void {
    const expected = this.config.get<string>('INTERNAL_SERVICE_TOKEN', '');
    if (!expected || token !== expected) throw new UnauthorizedException('Invalid internal service token.');
  }
}
