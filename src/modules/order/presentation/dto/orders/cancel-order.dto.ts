// DTO kiểm tra payload hủy đơn ở HTTP boundary; tên nhận hoàn phải đúng định dạng tên cá nhân.

import { Transform, Type } from 'class-transformer';
import {
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
    // Chỉ nhận chữ, khoảng trắng và dấu chấm/nháy đơn/gạch nối; tên vẫn phải khớp dữ liệu ngân hàng khi hoàn tiền.
    @Matches(/^\p{L}[\p{L}\p{M}]*(?:[ .'-][\p{L}\p{M}]+)*$/u, {
        message:
            "Tên chủ tài khoản chỉ được gồm chữ cái, khoảng trắng, dấu chấm (.), dấu nháy đơn ('), hoặc dấu gạch nối (-).",
    })
    accountHolder!: string;

    @IsString()
    @Matches(/^\d{6,30}$/)
    accountNumber!: string;
}

// Lý do hủy tùy chọn; tài khoản nhận hoàn chỉ gửi khi khách hủy đơn Pay2S đã thu tiền.
export class CancelOrderDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => RefundBankAccountDto)
    refundBankAccount?: RefundBankAccountDto;
}
