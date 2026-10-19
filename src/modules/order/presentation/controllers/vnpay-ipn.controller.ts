// Controller public nhận IPN từ VNPay; chữ ký và số tiền được xác thực trong PaymentService.
import { Controller, Get, Query } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { PaymentService } from '@/modules/order/application/services/payment/payment.service';

// Endpoint IPN không dùng session người mua; quyền ghi trạng thái chỉ đến từ chữ ký VNPay đã kiểm tra.
@Controller({ path: 'payments/vnpay', version: '1' })
export class VnpayIpnController {
    constructor(private readonly paymentService: PaymentService) {}

    // VNPay gửi GET query; phản hồi theo contract IPN và không tin return URL phía browser.
    @Get('ipn')
    @ApiExcludeEndpoint()
    processIpn(@Query() query: Record<string, unknown>) {
        return this.paymentService.processVnpayIpn(query);
    }

    // Return URL dùng cho trình duyệt; chữ ký vẫn được xác minh server-side trước khi trả trạng thái đã lưu.
    @Get('return')
    @ApiExcludeEndpoint()
    processReturn(@Query() query: Record<string, unknown>) {
        return this.paymentService.processVnpayReturn(query);
    }
}
