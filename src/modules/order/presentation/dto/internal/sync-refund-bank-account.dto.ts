// DTO đồng bộ thay đổi hồ sơ ngân hàng; endpoint chỉ nhận từ Auth Service qua internal token.

import { Type } from 'class-transformer';
import { IsBoolean, ValidateNested } from 'class-validator';
import { RefundBankAccountDto } from '@/modules/order/presentation/dto/orders/cancel-order.dto';

// Dữ liệu trước/sau đều dùng cùng quy tắc xác thực với thông tin khách nhập khi hủy đơn.
export class SyncRefundBankAccountDto {
    @IsBoolean()
    allowSingleAccountLegacySync!: boolean;

    @ValidateNested()
    @Type(() => RefundBankAccountDto)
    previousAccount!: RefundBankAccountDto;

    @ValidateNested()
    @Type(() => RefundBankAccountDto)
    account!: RefundBankAccountDto;
}
