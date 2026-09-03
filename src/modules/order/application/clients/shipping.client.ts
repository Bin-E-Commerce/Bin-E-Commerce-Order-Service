// Client nội bộ gửi quote tới Shipping Service; browser không biết token hoặc provider credential.

import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ShippingAddressInput {
  contactName: string;
  phone: string;
  addressLine: string;
  province: string;
  district: string;
  ward: string;
  ghnAddress?: GhnAddressSelectionInput;
}

export interface GhnAddressSelectionInput {
  provinceId: number;
  districtId: number;
  wardCode: string;
  districtName: string;
  wardName: string;
}

export interface ShippingQuote {
  provider: "GHN_TEST";
  shopId: string;
  serviceCode: string;
  serviceName: string;
  fee: string;
  baseFee: string;
  declaredValueFee: string;
  surcharges: Array<{ type: string; title: string; amount: string }>;
  deliverySupported: boolean;
  estimatedDeliveryAt: string | null;
}

export interface OrderShippingQuoteInput {
  shopId: string;
  to: ShippingAddressInput;
  shipmentKind?: "FORWARD" | "RETURN";
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  value: number;
  codAmount: number;
}

@Injectable()
export class ShippingClient {
  private readonly targetBase: string;
  private readonly internalToken: string;

  // Đọc endpoint nội bộ từ config để local và Docker dùng cùng một contract.
  constructor(config: ConfigService) {
    this.targetBase = config.get<string>("SHIPPING_SERVICE_URL", "http://localhost:3012");
    this.internalToken = config.get<string>("INTERNAL_SERVICE_TOKEN", "");
  }

  // Gửi quote cho một shop; pickup của Seller được Shipping Service resolve server-side.
  // Với shipmentKind=RETURN, Shipping Service đảo chiều tuyến thành customer → shop.
  async calculateQuote(input: OrderShippingQuoteInput): Promise<ShippingQuote> {
    let response: Response;
    try {
      response = await fetch(`${this.targetBase}/api/v1/internal/shipments/quotes`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-internal-service-token": this.internalToken,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new BadGatewayException("Shipping Service chưa sẵn sàng.");
    }
    const payload = (await response.json().catch(() => ({}))) as ShippingQuote & { message?: string };
    if (!response.ok) {
      if (response.status === 400) throw new BadRequestException(payload.message ?? "Địa chỉ giao hàng chưa đủ thông tin cho GHN.");
      throw new BadGatewayException(payload.message ?? "Không thể tính phí giao hàng lúc này.");
    }
    if (!payload.deliverySupported) throw new BadGatewayException("GHN chưa hỗ trợ giao tới địa chỉ này.");
    return payload;
  }

}
