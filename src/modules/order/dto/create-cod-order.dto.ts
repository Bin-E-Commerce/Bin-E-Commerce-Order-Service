// DTO này là contract đầu vào cho checkout COD.
// Client chỉ được gửi địa chỉ, phương thức thanh toán và ghi chú; giá, item và tổng tiền do server tính.

import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { PaymentMethod } from "../../../database/enums/payment-method.enum";

// Kiểm tra payload trước khi use case gọi các service bên ngoài hoặc mở transaction.
export class CreateCodOrderDto {
  @IsUUID("4", { message: "shippingAddressId phải là UUID hợp lệ." })
  shippingAddressId!: string;

  @IsEnum(PaymentMethod, { message: "Phase 1 chỉ hỗ trợ thanh toán COD." })
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString({ message: "note phải là chuỗi." })
  @MaxLength(500, { message: "note không được dài quá 500 ký tự." })
  note?: string;
}
