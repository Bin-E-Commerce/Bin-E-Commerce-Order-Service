// Public controller nhận IPN/redirect Pay2S; PaymentService là nơi xác minh chữ ký và cập nhật trạng thái.
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';

@Controller({ path: 'payments/pay2s', version: '1' })
export class Pay2sIpnController {
    constructor(private readonly paymentService: PaymentService) {}

    // Pay2S gửi JSON server-to-server; route không yêu cầu session người dùng.
    @Post('ipn')
    @ApiExcludeEndpoint()
    processIpn(@Body() body: Record<string, unknown>) {
        return this.paymentService.processPay2sIpn(body);
    }

    // Redirect chỉ đọc kết quả đã xác minh và lưu; không được xem là bằng chứng thay thế IPN.
    @Get('return')
    @ApiExcludeEndpoint()
    processReturn(@Query() query: Record<string, unknown>) {
        return this.paymentService.processPay2sReturn(query);
    }
}
