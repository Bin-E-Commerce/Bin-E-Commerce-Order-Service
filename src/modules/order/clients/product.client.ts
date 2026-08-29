// Client này yêu cầu Product Service revalidate và reserve toàn bộ cart trong một transaction của Product.
// Order Service không tin giá/stock snapshot trong Cart Service, cũng không tự sửa database Product.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CheckoutRejectedError,
  CheckoutResourceNotFoundError,
  OrderDependencyUnavailableError,
} from "../errors/order.errors";
import type {
  CheckoutReservationResponse,
  ReservationLine,
} from "../types/external-contracts.type";

// Adapter này giữ mapping status từ Product Service ở ngoài application service.
@Injectable()
export class ProductClient {
  private readonly targetBase: string;
  private readonly internalToken: string;

  // Cấu hình URL nội bộ và shared token một lần khi provider được khởi tạo.
  constructor(private readonly config: ConfigService) {
    this.targetBase = config.get<string>("PRODUCT_SERVICE_URL", "http://localhost:3008");
    this.internalToken = config.get<string>("INTERNAL_SERVICE_TOKEN", "");
  }

  // Revalidate product, tính snapshot giá hiện tại và reserve stock atomically theo reservationKey.
  async reserve(
    reservationKey: string,
    items: Array<{ productId: string; variantId: string; quantity: number }>,
  ): Promise<CheckoutReservationResponse> {
    return this.post<CheckoutReservationResponse>(
      "/api/v1/internal/checkout/reserve",
      { reservationKey, items },
    );
  }

  // Compensation được gọi khi Order Service đã reserve nhưng không thể commit order.
  async release(reservationKey: string, items: ReservationLine[]): Promise<void> {
    await this.post<{ released: boolean }>(
      "/api/v1/internal/checkout/release",
      { reservationKey, items },
    );
  }

  // Gọi Product Service và chuyển status thành lỗi có ý nghĩa với checkout.
  private async post<T>(path: string, body: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.targetBase}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-internal-service-token": this.internalToken,
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string } & T;
      if (response.status === 404) {
        throw new CheckoutResourceNotFoundError(data.message ?? "Không tìm thấy sản phẩm hoặc variant.");
      }
      if (response.status === 409 || response.status === 422) {
        throw new CheckoutRejectedError(data.message ?? "Sản phẩm không còn đủ điều kiện để đặt hàng.");
      }
      if (!response.ok) throw new OrderDependencyUnavailableError("Product Service");
      return data;
    } catch (error) {
      if (
        error instanceof CheckoutResourceNotFoundError ||
        error instanceof CheckoutRejectedError ||
        error instanceof OrderDependencyUnavailableError
      ) {
        throw error;
      }
      throw new OrderDependencyUnavailableError("Product Service");
    }
  }
}
