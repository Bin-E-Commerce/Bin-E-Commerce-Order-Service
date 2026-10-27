// Public webhook SePay chuyển giao dịch tiền ra vào application service để xác thực và đối soát payout.
import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SepayPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/sepay-payout-reconciliation.service';

// Endpoint công khai nhận sự kiện tiền ra; quyền ghi payout đến từ API Key SePay được application service xác thực.
@Controller({ path: 'payments/sepay', version: '1' })
export class SepayPayoutWebhookController {
    constructor(
        private readonly reconciliationService: SepayPayoutReconciliationService,
    ) {}

    // SePay gửi Authorization: Apikey; service kiểm tra khóa, tài khoản nguồn và giao dịch trước khi ghi ledger.
    @Post('payout-webhook')
    @ApiExcludeEndpoint()
    processPayoutWebhook(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: unknown,
    ): Promise<{ success: true }> {
        return this.reconciliationService.processWebhook(authorization, body);
    }
}
