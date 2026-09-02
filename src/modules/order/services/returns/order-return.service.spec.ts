/// <reference types="jest" />

import { type DeepMocked } from "@golevelup/ts-jest";
import { Repository } from "typeorm";
import { OrderReturnRequest } from "../../../../database/returns/entities/order-return-request.entity";
import { OrderReturnReason } from "../../../../database/returns/enums/order-return-reason.enum";
import { OrderReturnStatus } from "../../../../database/returns/enums/order-return-status.enum";
import { OrderFulfillmentStatus } from "../../../../database/order/enums/order-fulfillment-status.enum";
import { OrderRepository } from "../../repositories/order.repository";
import { SellerShopClient } from "../../clients/seller-shop.client";
import { OrderEventsService } from "../order/order-events.service";
import { ShippingClient } from "../../clients/shipping.client";
import { OrderReturnService } from "./order-return.service";

describe("OrderReturnService", () => {
  let service: OrderReturnService;
  let returns: DeepMocked<Repository<OrderReturnRequest>>;
  let orders: DeepMocked<OrderRepository>;
  let shops: DeepMocked<SellerShopClient>;
  let events: DeepMocked<OrderEventsService>;
  let shipping: DeepMocked<ShippingClient>;

  const orderData = {
    id: "order-1",
    ownerId: "customer-1",
    orderNumber: "BIN-0001",
    fulfillmentStatus: OrderFulfillmentStatus.COMPLETED,
    returnWindowUntil: new Date(Date.now() + 86_400_000),
    shippingFee: "30000.00",
    subtotal: "300000.00",
    shippingAddress: {
      fullName: "Nguyễn Văn A",
      phone: "0900000000",
      street: "123 Đường Test",
      province: "Hồ Chí Minh",
      district: "Quận 1",
      ward: "Phường Bến Nghé",
      ghnAddress: {
        provinceId: 202,
        districtId: 1442,
        wardCode: "20101",
        districtName: "Quận 1",
        wardName: "Phường Bến Nghé",
      },
    },
    items: [
      { id: "item-1", sellerShopId: "shop-1", sellerOwnerId: "seller-1", lineTotal: "100000.00", quantity: 1, packageWeightGrams: 500, packageLengthCm: "20", packageWidthCm: "15", packageHeightCm: "10" },
      { id: "item-2", sellerShopId: "shop-2", sellerOwnerId: "seller-2", lineTotal: "200000.00", quantity: 1, packageWeightGrams: 500, packageLengthCm: "20", packageWidthCm: "15", packageHeightCm: "10" },
    ],
  };
  const order = orderData as never;

  beforeEach(async () => {
    returns = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn() } as unknown as DeepMocked<Repository<OrderReturnRequest>>;
    orders = { findOwnedById: jest.fn() } as unknown as DeepMocked<OrderRepository>;
    shops = { getOwnedShopId: jest.fn() } as unknown as DeepMocked<SellerShopClient>;
    events = { publishReturnChanged: jest.fn() } as unknown as DeepMocked<OrderEventsService>;
    shipping = { calculateQuote: jest.fn() } as unknown as DeepMocked<ShippingClient>;
    shipping.calculateQuote.mockResolvedValue({ fee: "11942.86" } as never);
    service = new OrderReturnService(returns, orders, shops, events, shipping);
    orders.findOwnedById.mockResolvedValue(order);
    const savedRequest = {} as OrderReturnRequest;
    (returns as any).create = jest.fn((value: OrderReturnRequest) => Object.assign(savedRequest, value));
    (returns as any).save = jest.fn(async () => savedRequest);
  });

  it("creates a seller-fault return with proportional shipping refund", async () => {
    const result = await service.create("customer-1", "order-1", {
      itemIds: ["item-1"],
      reason: OrderReturnReason.DAMAGED,
      evidence: [{ assetId: "asset-1", url: "https://cdn.test/evidence.webp", type: "image" }],
    });

    const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
    expect(persisted.status).toBe(OrderReturnStatus.REQUESTED);
    expect(persisted.refundAmount).toBe("110000.00");
    expect(persisted.refundItemAmount).toBe("100000.00");
    expect(persisted.refundShippingAmount).toBe("10000.00");
    expect(persisted.returnShippingCost).toBe("11943.00");
    expect(events.publishReturnChanged).toHaveBeenCalled();
    expect(shipping.calculateQuote).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1",
      shipmentKind: "RETURN",
      value: 100000,
      codAmount: 0,
    }));
  });

  it("rounds proportional refund amounts to whole VND", async () => {
    orders.findOwnedById.mockResolvedValue({
      ...orderData,
      shippingFee: "30000.00",
      subtotal: "300000.00",
      items: [{ ...orderData.items[0], lineTotal: "100000.86" }],
    } as never);

    await service.create("customer-1", "order-1", {
      itemIds: ["item-1"],
      reason: OrderReturnReason.DAMAGED,
      evidence: [{ assetId: "asset-1", url: "https://cdn.test/evidence.webp", type: "image" }],
    });

    const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
    expect(persisted.refundItemAmount).toBe("100001.00");
    expect(persisted.refundShippingAmount).toBe("10000.00");
    expect(persisted.refundAmount).toBe("110001.00");
  });

  it("charges reverse shipping only to a customer-fault return", async () => {
    const request = {
      id: "return-1",
      status: OrderReturnStatus.AWAITING_SHIPMENT,
      reason: OrderReturnReason.CHANGE_OF_MIND,
      refundItemAmount: "100000.00",
      refundShippingAmount: "0.00",
      returnShippingFee: "0.00",
      returnShippingCost: "0.00",
      refundAmount: "100000.00",
    } as OrderReturnRequest;
    returns.findOne.mockResolvedValue(request);
    returns.save.mockResolvedValue(request);

    await service.updateReturnShippingCost("return-1", "12345.50");

    expect(request.returnShippingCost).toBe("12346.00");
    expect(request.returnShippingFee).toBe("12346.00");
    expect(request.refundAmount).toBe("87654.00");
  });

  it("rejects fault returns without an image evidence", async () => {
    await expect(service.create("customer-1", "order-1", {
      itemIds: ["item-1"],
      reason: OrderReturnReason.WRONG_ITEM,
      evidence: [],
    })).rejects.toThrow("cần ít nhất một ảnh");
  });

  it("rejects a request spanning multiple shops", async () => {
    await expect(service.create("customer-1", "order-1", {
      itemIds: ["item-1", "item-2"],
      reason: OrderReturnReason.CHANGE_OF_MIND,
    })).rejects.toThrow("một shop");
  });
});
