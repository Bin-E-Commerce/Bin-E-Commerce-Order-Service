// Adapter này lấy shop thuộc user Seller từ Seller Service để Order Service không tin shopId do browser truyền lên.
// Response shop chỉ phục vụ authorization/query scope, không được trả nguyên dữ liệu shop sang frontend Seller order.

import { BadGatewayException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { SellerOrderUserContext } from "../types/seller-order-user-context.type";

interface SellerShopProfileResponse {
  shop?: {
    id?: string;
  };
}

@Injectable()
export class SellerShopClient {
  private readonly targetBase: string;

  // Đọc URL Seller Service từ environment để local và Docker dùng cùng một adapter.
  constructor(config: ConfigService) {
    this.targetBase = config.get<string>(
      "SELLER_SERVICE_URL",
      "http://localhost:3007",
    );
  }

  // Resolve shop bằng user context đã xác thực; lỗi upstream được chuyển thành lỗi có nghĩa với order API.
  async getOwnedShopId(currentUser: SellerOrderUserContext): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.targetBase}/api/v1/seller/shop/profile`, {
        headers: {
          accept: "application/json",
          "x-user-id": currentUser.userId,
          "x-user-email": currentUser.email,
          "x-user-permissions": currentUser.permissions.join(","),
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new BadGatewayException(
        "Không thể xác minh shop lúc này. Vui lòng thử lại sau.",
      );
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new NotFoundException("Không tìm thấy shop của tài khoản hiện tại.");
    }
    if (!response.ok) {
      throw new BadGatewayException(
        "Seller Service chưa sẵn sàng để xác minh shop.",
      );
    }

    const profile = (await response.json()) as SellerShopProfileResponse;
    const shopId = profile.shop?.id;
    if (!shopId) {
      throw new NotFoundException("Không tìm thấy shop của tài khoản hiện tại.");
    }
    return shopId;
  }
}
