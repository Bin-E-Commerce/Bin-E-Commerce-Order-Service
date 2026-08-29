// File này gom các lỗi boundary của checkout để controller trả status nhất quán.

import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

// Cart trống không thể tạo order và không nên mở reservation tồn kho.
export class EmptyCartError extends UnprocessableEntityException {
  constructor() {
    super("Giỏ hàng đang trống, không thể tạo đơn.");
  }
}

// Dùng khi cùng idempotency key được gửi lại với payload khác lần đầu.
export class IdempotencyConflictError extends ConflictException {
  constructor() {
    super("Idempotency-Key đã được sử dụng cho một yêu cầu checkout khác.");
  }
}

// Lỗi này phân biệt upstream không sẵn sàng với lỗi dữ liệu do người dùng chọn.
export class OrderDependencyUnavailableError extends ServiceUnavailableException {
  constructor(serviceName: string) {
    super(`${serviceName} hiện không sẵn sàng. Vui lòng thử lại sau.`);
  }
}

// Product Service trả lỗi không mua được hoặc hết hàng; không được tạo order CONFIRMED.
export class CheckoutRejectedError extends UnprocessableEntityException {
  constructor(message: string) {
    super(message);
  }
}

// Giữ status 404 cho cart/address/variant không tồn tại theo API contract.
export class CheckoutResourceNotFoundError extends NotFoundException {
  constructor(message: string) {
    super(message);
  }
}

// Chặn hủy các trạng thái không còn cho phép thay đổi và giữ lỗi nghiệp vụ ở HTTP 409.
export class OrderCancellationConflictError extends ConflictException {
  constructor(status: string) {
    super(`Không thể hủy đơn ở trạng thái ${status}.`);
  }
}
