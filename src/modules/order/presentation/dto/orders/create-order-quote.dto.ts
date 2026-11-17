// DTO quote chỉ nhận địa chỉ giao và phương thức thanh toán; cart, giá và shop được đọc server-side.
import {
    ArrayMaxSize,
    ArrayNotEmpty,
    ArrayUnique,
    IsArray,
    IsEnum,
    IsOptional,
    IsUUID,
} from 'class-validator';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';

// Request dùng trước checkout để hiển thị phí vận chuyển tạm tính.
export class CreateOrderQuoteDto {
    @IsUUID('4')
    shippingAddressId!: string;

    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    @IsOptional()
    @IsUUID('4')
    cartItemId?: string;

    @IsOptional()
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(100)
    @ArrayUnique()
    @IsUUID('4', { each: true })
    cartItemIds?: string[];
}
