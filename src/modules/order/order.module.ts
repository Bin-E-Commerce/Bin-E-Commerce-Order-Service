// File này tổ chức toàn bộ bounded context Order theo các lớp controller, client, repository và application service.

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '@/database/order/entities/order.entity';
import { OrderItem } from '@/database/order/entities/order-item.entity';
import { OrderStatusHistory } from '@/database/order/entities/order-status-history.entity';
import { OrderController } from '@/modules/order/presentation/controllers/order.controller';
import { SellerOrderController } from '@/modules/order/presentation/controllers/seller-order.controller';
import { InternalOrderController } from '@/modules/order/presentation/controllers/internal-order.controller';
import { InternalRecommendationController } from '@/modules/order/presentation/controllers/internal-recommendation.controller';
import { AuthClient } from '@/modules/order/application/clients/auth.client';
import { CartClient } from '@/modules/order/application/clients/cart.client';
import { ProductClient } from '@/modules/order/application/clients/product.client';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { OrderRepository } from '@/modules/order/infrastructure/repositories/order.repository';
import { OrderCommandService } from '@/modules/order/application/services/order/order-command.service';
import { OrderResponseMapper } from '@/modules/order/application/services/order/order-response-mapper.service';
import { SellerOrderAccessService } from '@/modules/order/application/services/order/seller-order-access.service';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { ShippingClient } from '@/modules/order/application/clients/shipping.client';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnService } from '@/modules/order/application/services/returns/order-return.service';
import { OrderDeliveryIssue } from '@/database/delivery/entities/order-delivery-issue.entity';
import { OrderDeliveryConfirmationService } from '@/modules/order/application/services/delivery/order-delivery-confirmation.service';
import { OrderDeliveryAutomationService } from '@/modules/order/application/services/delivery/order-delivery-automation.service';
import { ShipmentStatusConsumer } from '@/kafka/shipment-status.consumer';
import { OrderPurchaseEventOutboxEntity } from '@/database/integration/entities/order-purchase-event-outbox.entity';
import { SellerDashboardOrderService } from '@/modules/order/application/services/dashboard/seller-dashboard-order.service';

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
        ]),
    ],
    controllers: [
        OrderController,
        SellerOrderController,
        InternalOrderController,
        InternalRecommendationController,
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
        ShippingClient,
        OrderReturnService,
        OrderDeliveryConfirmationService,
        OrderDeliveryAutomationService,
        SellerDashboardOrderService,
        ShipmentStatusConsumer,
    ],
})
export class OrderModule {}
