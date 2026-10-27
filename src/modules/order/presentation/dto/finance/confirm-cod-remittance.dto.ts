// DTO cho thao tác đối soát COD; mã giao dịch là bắt buộc để lưu vết kiểm toán.
import { IsString, MaxLength, MinLength } from 'class-validator';

// Chặn yêu cầu rỗng/quá dài trước khi ứng dụng ghi nhận remittance và credit ví seller.
export class ConfirmCodRemittanceDto {
    @IsString()
    @MinLength(3)
    @MaxLength(120)
    reference!: string;
}
