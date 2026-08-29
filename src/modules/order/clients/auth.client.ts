// Client này xác nhận địa chỉ giao hàng từ Auth Service.
// Order Service không nhận nguyên địa chỉ từ browser và không lưu live reference tới bảng user_addresses.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CheckoutResourceNotFoundError,
  OrderDependencyUnavailableError,
} from "../errors/order.errors";
import type { ShippingAddressResponse } from "../types/external-contracts.type";

// Chỉ expose một thao tác đọc địa chỉ thuộc owner hiện tại cho use case checkout.
@Injectable()
export class AuthClient {
  private readonly targetBase: string;
  private readonly internalToken: string;

  // Đọc endpoint Auth Service từ environment thay vì hard-code trong application service.
  constructor(private readonly config: ConfigService) {
    this.targetBase = config.get<string>("AUTH_SERVICE_URL", "http://localhost:3001");
    this.internalToken = config.get<string>("INTERNAL_SERVICE_TOKEN", "");
  }

  // Auth Service tự kiểm tra addressId thuộc keycloak ownerId trước khi trả snapshot.
  async getOwnedAddress(ownerId: string, addressId: string): Promise<ShippingAddressResponse> {
    try {
      const response = await fetch(`${this.targetBase}/api/v1/internal/users/addresses/${addressId}`, {
        signal: AbortSignal.timeout(5000),
        headers: {
          accept: "application/json",
          "x-user-id": ownerId,
          "x-internal-service-token": this.internalToken,
        },
      });
      if (response.status === 404) {
        throw new CheckoutResourceNotFoundError("Không tìm thấy địa chỉ giao hàng của tài khoản.");
      }
      if (!response.ok) throw new OrderDependencyUnavailableError("Auth Service");
      return (await response.json()) as ShippingAddressResponse;
    } catch (error) {
      if (error instanceof CheckoutResourceNotFoundError || error instanceof OrderDependencyUnavailableError) {
        throw error;
      }
      throw new OrderDependencyUnavailableError("Auth Service");
    }
  }
}
