// DTO kiểm tra payload hủy đơn ở HTTP boundary; tên nhận hoàn phải đúng định dạng tên cá nhân.

import { Transform, Type } from 'class-transformer';
import {
    IsDefined,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';

// Xác thực thông tin người nhận hoàn trước khi đưa dữ liệu nhạy cảm vào Order Service.
export class RefundBankAccountDto {
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    bankCode!: string;

    @IsString()
    @MinLength(2)
    @MaxLength(100)
    bankName!: string;

    @IsString()
    @MinLength(2)
    @MaxLength(100)
    // Chuẩn hóa Unicode, khoảng trắng và chữ hoa trước các decorator kiểm tra cùng giá trị mà service sẽ lưu.
    @Transform(({ value }) =>
        typeof value === 'string'
            ? value
                  .normalize('NFC')
                  .trim()
                  .replace(/\s+/gu, ' ')
                  .toLocaleUpperCase('vi-VN')
            : value,
    )
    // Chỉ nhận chữ Unicode và khoảng trắng; tên vẫn phải khớp dữ liệu ngân hàng khi hoàn tiền.
    @Matches(/^\p{L}[\p{L}\p{M}]*(?: \p{L}[\p{L}\p{M}]*)*$/u, {
        message:
            'Tên chủ tài khoản chỉ được gồm chữ cái có dấu và khoảng trắng.',
    })
    accountHolder!: string;

    @IsString()
    @Matches(/^\d{6,30}$/)
    accountNumber!: string;
}

// Tài khoản nhận hoàn chỉ gửi khi khách hủy đơn Pay2S đã thu tiền.
export class CancelOrderDto {
    // Trim trước validation để chuỗi toàn khoảng trắng cũng bị coi là chưa nhập lý do.
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim() : value,
    )
    @IsDefined({
        message: 'Vui lòng chọn hoặc nhập lý do hủy đơn hàng.',
    })
    @IsString()
    @MinLength(1, {
        message: 'Vui lòng chọn hoặc nhập lý do hủy đơn hàng.',
    })
    @MaxLength(500)
    reason?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => RefundBankAccountDto)
    refundBankAccount?: RefundBankAccountDto;
}
