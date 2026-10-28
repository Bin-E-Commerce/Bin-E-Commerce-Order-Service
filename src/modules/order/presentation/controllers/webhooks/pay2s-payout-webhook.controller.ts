// Public webhook Pay2S nhận thông báo giao dịch OUT để chờ admin đối chiếu tài khoản thụ hưởng.
import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Pay2sPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/pay2s-payout-reconciliation.service';

// Endpoint công khai chỉ nhận callback; quyền ghi nhận candidate đến từ bearer token kiểm tra trong application service.
@Controller({ path: 'payments/pay2s', version: '1' })
export class Pay2sPayoutWebhookController {
    constructor(
        private readonly reconciliationService: Pay2sPayoutReconciliationService,
    ) {}

    // Pay2S gửi Authorization: Bearer; service xác thực token, nguồn tiền, memo và số tiền trước khi lưu event.
    @Post('payout-webhook')
    @ApiExcludeEndpoint()
    processPayoutWebhook(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: unknown,
    ): Promise<{ success: true }> {
        return this.reconciliationService.processWebhook(authorization, body);
    }
}
