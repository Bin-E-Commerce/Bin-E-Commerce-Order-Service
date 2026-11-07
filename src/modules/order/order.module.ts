// File này tổ chức toàn bộ bounded context Order theo các lớp controller, client, repository và application service.

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { OrderController } from '@/modules/order/presentation/controllers/orders/order.controller';
import { SellerOrderController } from '@/modules/order/presentation/controllers/orders/seller-order.controller';
import { InternalOrderController } from '@/modules/order/presentation/controllers/internal/internal-order.controller';
import { InternalRecommendationController } from '@/modules/order/presentation/controllers/internal/internal-recommendation.controller';
import { AuthClient } from '@/modules/order/application/clients/auth.client';
import { CartClient } from '@/modules/order/application/clients/cart.client';
import { ProductClient } from '@/modules/order/application/clients/product.client';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { OrderRepository } from '@/modules/order/infrastructure/repositories/orders/order.repository';
import { OrderCommandService } from '@/modules/order/application/services/order/order-command.service';
import { OrderResponseMapper } from '@/modules/order/application/services/order/order-response-mapper.service';
import { SellerOrderAccessService } from '@/modules/order/application/services/order/seller-order-access.service';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { AdminRefundConfirmationService } from '@/modules/order/application/services/finance/admin-refund-confirmation.service';
import { ShippingClient } from '@/modules/order/application/clients/shipping.client';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnService } from '@/modules/order/application/services/returns/order-return.service';
import { CustomerReturnRequestEditService } from '@/modules/order/application/services/returns/customer-return-request-edit.service';
import { ReturnRequestEditRepository } from '@/modules/order/infrastructure/repositories/returns/return-request-edit.repository';
import { RETURN_REQUEST_EDIT_REPOSITORY } from '@/modules/order/application/contracts/return-request-edit.repository';
import { OrderReturnShipmentRepository } from '@/modules/order/infrastructure/repositories/returns/order-return-shipment.repository';
import { ORDER_RETURN_SHIPMENT_REPOSITORY } from '@/modules/order/application/contracts/order-return-shipment.repository';
import { OrderDeliveryIssue } from '@/database/delivery/entities/order-delivery-issue.entity';
import { OrderDeliveryConfirmationService } from '@/modules/order/application/services/delivery/order-delivery-confirmation.service';
import { OrderDeliveryAutomationService } from '@/modules/order/application/services/delivery/order-delivery-automation.service';
import { ShipmentStatusConsumer } from '@/kafka/shipment-status.consumer';
import { OrderPurchaseEventOutboxEntity } from '@/database/integration/entities/order-purchase-event-outbox.entity';
import { WalletFinanceNotificationOutboxEntity } from '@/database/integration/entities/wallet-finance-notification-outbox.entity';
import { SellerDashboardOrderService } from '@/modules/order/application/services/dashboard/seller-dashboard-order.service';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { SellerWallet } from '@/database/payment/entities/seller-wallet.entity';
import { SellerWalletLedger } from '@/database/payment/entities/seller-wallet-ledger.entity';
import { Pay2sIpnController } from '@/modules/order/presentation/controllers/webhooks/pay2s-ipn.controller';
import { Pay2sPayoutWebhookController } from '@/modules/order/presentation/controllers/webhooks/pay2s-payout-webhook.controller';
import { PaymentService } from '@/modules/order/application/services/payment/checkout/payment.service';
import { Pay2sPayoutReconciliationService } from '@/modules/order/application/services/payment/payouts/pay2s-payout-reconciliation.service';
import { Pay2sGatewayService } from '@/modules/order/application/services/payment/checkout/pay2s-gateway.service';
import { SellerWalletRepository } from '@/modules/order/infrastructure/repositories/finance/seller-wallet.repository';
import { RefundCompletionRepository } from '@/modules/order/infrastructure/repositories/finance/refund-completion.repository';
import { REFUND_COMPLETION_REPOSITORY } from '@/modules/order/application/contracts/refund-completion.repository';
import { SELLER_WALLET_REPOSITORY } from '@/modules/order/application/contracts/seller-wallet.repository';
import { SellerFinanceController } from '@/modules/order/presentation/controllers/finance/seller-finance.controller';
import { AdminFinanceController } from '@/modules/order/presentation/controllers/finance/admin-finance.controller';
import { WalletDeposit } from '@/database/payment/entities/wallet-deposit.entity';
import { WalletWithdrawalRequest } from '@/database/payment/entities/wallet-withdrawal-request.entity';
import { PlatformFinanceLedger } from '@/database/payment/entities/platform-finance-ledger.entity';
import { FinanceSettlementBatch } from '@/database/payment/entities/finance-settlement-batch.entity';
import { WalletFinanceEventOutboxDispatcher } from '@/modules/order/infrastructure/events/wallet-finance-event-outbox-dispatcher.service';
import { SellerWalletDebtService } from '@/modules/order/application/services/finance/seller-wallet-debt.service';
import { SellerWalletDebtRepository } from '@/modules/order/infrastructure/repositories/finance/seller-wallet-debt.repository';
import { SELLER_WALLET_DEBT_REPOSITORY } from '@/modules/order/application/contracts/finance/seller-wallet-debt.repository';
import { SellerFinanceLockClient } from '@/modules/order/application/clients/finance/seller-finance-lock.client';

// Module chỉ expose controller Order; cross-service call được giữ trong client adapter tương ứng.
@Module({
    imports: [
        TypeOrmModule.forFeature([
            Order,
            OrderItem,
            OrderStatusHistory,
            OrderReturnRequest,
            OrderDeliveryIssue,
            OrderPurchaseEventOutboxEntity,
            WalletFinanceNotificationOutboxEntity,
            PaymentAttempt,
            SellerWallet,
            SellerWalletLedger,
            WalletDeposit,
            WalletWithdrawalRequest,
            PlatformFinanceLedger,
            FinanceSettlementBatch,
        ]),
    ],
    controllers: [
        OrderController,
        SellerOrderController,
        InternalOrderController,
        InternalRecommendationController,
        Pay2sIpnController,
        Pay2sPayoutWebhookController,
        SellerFinanceController,
        AdminFinanceController,
    ],
    providers: [
        OrderRepository,
        OrderResponseMapper,
        OrderCommandService,
        CartClient,
        AuthClient,
        ProductClient,
        SellerShopClient,
        SellerOrderAccessService,
        OrderEventsService,
        AdminRefundConfirmationService,
        ShippingClient,
        OrderReturnService,
        CustomerReturnRequestEditService,
        ReturnRequestEditRepository,
        {
            provide: RETURN_REQUEST_EDIT_REPOSITORY,
            useExisting: ReturnRequestEditRepository,
        },
        OrderReturnShipmentRepository,
        {
            provide: ORDER_RETURN_SHIPMENT_REPOSITORY,
            useExisting: OrderReturnShipmentRepository,
        },
        OrderDeliveryConfirmationService,
        OrderDeliveryAutomationService,
        SellerDashboardOrderService,
        ShipmentStatusConsumer,
        WalletFinanceEventOutboxDispatcher,
        PaymentService,
        Pay2sPayoutReconciliationService,
        Pay2sGatewayService,
        SellerWalletRepository,
        SellerWalletDebtRepository,
        SellerWalletDebtService,
        SellerFinanceLockClient,
        RefundCompletionRepository,
        {
            provide: REFUND_COMPLETION_REPOSITORY,
            useExisting: RefundCompletionRepository,
        },
        {
            provide: SELLER_WALLET_REPOSITORY,
            useExisting: SellerWalletRepository,
        },
        {
            provide: SELLER_WALLET_DEBT_REPOSITORY,
            useExisting: SellerWalletDebtRepository,
        },
    ],
})
export class OrderModule {}
