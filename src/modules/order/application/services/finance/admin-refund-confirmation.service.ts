// Điều phối xác nhận hoàn của admin và phát event cho Notification Service sau khi repository commit thành công.
// Service chỉ dùng repository port và OrderEventsService; trạng thái ledger vẫn do SellerWalletRepository sở hữu.

import {
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { REFUND_COMPLETION_REPOSITORY } from '@/modules/order/application/contracts/refund-completion.repository';
import type { RefundCompletionRepositoryPort } from '@/modules/order/application/contracts/refund-completion.repository';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import type { SellerWalletRepositoryPort } from '@/modules/order/application/contracts/seller-wallet.repository';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import type { RefundCompletionSourceType } from '@/modules/order/application/types/finance/refund-completion.type';

@Injectable()
export class AdminRefundConfirmationService {
    constructor(
        @Inject(SELLER_WALLET_REPOSITORY)
        private readonly walletRepository: SellerWalletRepositoryPort,
        @Inject(REFUND_COMPLETION_REPOSITORY)
        private readonly completionRepository: RefundCompletionRepositoryPort,
        private readonly orderEvents: OrderEventsService,
    ) {}

    // Chốt attempt và thông báo đúng customer; repository giữ nguyên kiểm tra amount, trạng thái và ledger hiện có.
    async confirmPaymentAttempt(input: {
        paymentAttemptId: string;
        adminId: string;
        amount: string;
    }): Promise<void> {
        await this.walletRepository.recordPaymentAttemptRefund(input);
        await this.publishCompletion('PAYMENT_ATTEMPT', input.paymentAttemptId);
    }

    // Chốt return đã duyệt; event được dựng từ snapshot DB nên email không tin recipient do browser gửi lên.
    async confirmReturn(input: {
        returnRequestId: string;
        adminId: string;
        amount: string;
    }): Promise<void> {
        await this.walletRepository.recordReturnRefund(input);
        await this.publishCompletion('ORDER_RETURN', input.returnRequestId);
    }

    // Chốt delivery issue đã duyệt rồi gửi cùng event chuẩn như các nguồn hoàn khác.
    async confirmDeliveryIssue(input: {
        issueId: string;
        adminId: string;
        amount: string;
    }): Promise<void> {
        await this.walletRepository.recordDeliveryIssueRefund(input);
        await this.publishCompletion('DELIVERY_ISSUE', input.issueId);
    }

    // Giữ COD refund trên repository wallet và công bố email sau khi giao dịch đã commit.
    async confirmCodReturn(input: {
        returnRequestId: string;
        adminId: string;
        amount: string;
    }): Promise<void> {
        await this.walletRepository.recordCodRefund(input);
        await this.publishCompletion('ORDER_RETURN', input.returnRequestId);
    }

    // Retry cùng ID tạo lại cùng eventId; nếu Kafka chưa nhận event, admin có thể xác nhận lại an toàn.
    private async publishCompletion(
        sourceType: RefundCompletionSourceType,
        refundId: string,
    ): Promise<void> {
        const snapshot = await this.completionRepository.findCompletedRefund(
            sourceType,
            refundId,
        );
        if (!snapshot) {
            throw new ServiceUnavailableException(
                'Đã cập nhật khoản hoàn nhưng chưa thể dựng thông báo cho khách. Hãy thử xác nhận lại.',
            );
        }

        const published =
            await this.orderEvents.publishRefundCompleted(snapshot);
        if (!published) {
            throw new ServiceUnavailableException(
                'Đã xác nhận khoản hoàn nhưng email chưa được xếp hàng. Hãy thử xác nhận lại để gửi thông báo.',
            );
        }
    }
}
