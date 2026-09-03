// File này tổ chức toàn bộ bounded context Order theo các lớp controller, client, repository và application service.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Order } from "../../database/order/entities/order.entity";
import { OrderItem } from "../../database/order/entities/order-item.entity";
import { OrderStatusHistory } from "../../database/order/entities/order-status-history.entity";
import { OrderController } from "./presentation/controllers/order.controller";
import { SellerOrderController } from "./presentation/controllers/seller-order.controller";
import { InternalOrderController } from "./presentation/controllers/internal-order.controller";
import { AuthClient } from "./application/clients/auth.client";
import { CartClient } from "./application/clients/cart.client";
import { ProductClient } from "./application/clients/product.client";
import { SellerShopClient } from "./application/clients/seller-shop.client";
import { OrderRepository } from "./infrastructure/repositories/order.repository";
import { OrderCommandService } from "./application/services/order/order-command.service";
import { OrderResponseMapper } from "./application/services/order/order-response-mapper.service";
import { SellerOrderAccessService } from "./application/services/order/seller-order-access.service";
import { OrderEventsService } from "./application/services/order/order-events.service";
import { ShippingClient } from "./application/clients/shipping.client";
import { OrderReturnRequest } from "../../database/returns/entities/order-return-request.entity";
import { OrderReturnService } from "./application/services/returns/order-return.service";
import { OrderDeliveryIssue } from "../../database/delivery/entities/order-delivery-issue.entity";
import { OrderDeliveryConfirmationService } from "./application/services/delivery/order-delivery-confirmation.service";
import { OrderDeliveryAutomationService } from "./application/services/delivery/order-delivery-automation.service";
import { ShipmentStatusConsumer } from "../../kafka/shipment-status.consumer";

// Module chỉ expose controller Order; cross-service call được giữ trong client adapter tương ứng.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderStatusHistory,
      OrderReturnRequest,
      OrderDeliveryIssue,
    ]),
  ],
  controllers: [
    OrderController,
    SellerOrderController,
    InternalOrderController,
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
    ShipmentStatusConsumer,
  ],
})
export class OrderModule {}
