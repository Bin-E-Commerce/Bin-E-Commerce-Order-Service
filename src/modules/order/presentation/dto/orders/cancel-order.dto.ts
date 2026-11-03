import { Type } from 'class-transformer';
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
