// File này tổ chức toàn bộ bounded context Order theo các lớp controller, client, repository và application service.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Order } from "../../database/entities/order.entity";
import { OrderItem } from "../../database/entities/order-item.entity";
import { OrderStatusHistory } from "../../database/entities/order-status-history.entity";
import { OrderController } from "./controllers/order.controller";
import { SellerOrderController } from "./controllers/seller-order.controller";
import { InternalOrderController } from "./controllers/internal-order.controller";
import { AuthClient } from "./clients/auth.client";
import { CartClient } from "./clients/cart.client";
import { ProductClient } from "./clients/product.client";
import { SellerShopClient } from "./clients/seller-shop.client";
import { OrderRepository } from "./repositories/order.repository";
import { OrderCommandService } from "./services/order-command.service";
import { OrderResponseMapper } from "./services/order-response-mapper.service";
import { SellerOrderAccessService } from "./services/seller-order-access.service";
import { OrderEventsService } from "./services/order-events.service";
import { ShippingClient } from "./clients/shipping.client";
import { OrderReturnRequest } from "../../database/entities/order-return-request.entity";
import { OrderReturnService } from "./services/order-return.service";

// Module chỉ expose controller Order; cross-service call được giữ trong client adapter tương ứng.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderStatusHistory,
      OrderReturnRequest,
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
  ],
})
export class OrderModule {}
