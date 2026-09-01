// File này xác thực context tối thiểu cho Seller order API và giữ permission check ở downstream service.
// Service không tự suy diễn shop từ input của trình duyệt; shop sẽ được resolve bằng userId tin cậy.

import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { SellerOrderUserContext } from "../../types/seller-order-user-context.type";

const SELLER_ORDER_READ_PERMISSION = "seller.order.read";

@Injectable()
export class SellerOrderAccessService {
  // Dựng context Seller từ các header được Gateway forward để các lớp phía sau dùng cùng một nguồn danh tính.
  buildCurrentUserFromHeaders(
    headers: Record<string, unknown>,
  ): SellerOrderUserContext {
    return {
      userId: this.getHeaderValue(headers, "x-user-id") ?? "",
      email: this.getHeaderValue(headers, "x-user-email") ?? "",
      permissions: this.parseHeaderList(
        this.getHeaderValue(headers, "x-user-permissions") ?? "",
      ),
    };
  }

  // Chặn request gọi thẳng Order Service khi thiếu danh tính hoặc permission Seller riêng của module.
  ensureCanRead(
    currentUser: SellerOrderUserContext,
  ): SellerOrderUserContext {
    if (!currentUser.userId || !currentUser.email) {
      throw new UnauthorizedException(
        "Bạn cần đăng nhập để xem đơn hàng của shop.",
      );
    }
    if (!currentUser.permissions.includes(SELLER_ORDER_READ_PERMISSION)) {
      throw new ForbiddenException(
        "Bạn không có quyền xem đơn hàng của shop.",
      );
    }
    return currentUser;
  }

  // Đọc an toàn header đơn hoặc header lặp do Node chuẩn hóa về chuỗi.
  private getHeaderValue(
    headers: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = headers[key];
    if (Array.isArray(value)) return value[0];
    return typeof value === "string" ? value : undefined;
  }

  // Chuẩn hóa danh sách permission phân tách bằng dấu phẩy trước khi kiểm tra chính xác.
  private parseHeaderList(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
