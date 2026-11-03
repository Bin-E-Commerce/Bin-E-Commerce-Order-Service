// DTO cho admin bổ sung tài khoản nhận của các khoản hoàn Pay2S cũ chưa lưu dữ liệu người nhận.
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Chỉ nhận mã ngân hàng, tên chủ tài khoản và số tài khoản đã đủ định dạng để chuyển thủ công hoặc tạo VietQR.
export class UpdateRefundRecipientAccountDto {
    @IsString()
    @Matches(/^[a-z0-9-]{2,50}$/i)
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
