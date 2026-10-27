// DTO xác nhận admin đã chuyển khoản hoàn COD bên ngoài; amount phải khớp snapshot hoàn đã tính phía server.
import {
    IsObject,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

// Bắt buộc mã giao dịch, số tiền hợp lệ và metadata bằng chứng để truy vết thao tác tài chính.
export class ConfirmCodRefundDto {
    @IsString()
    @Matches(/^\d{1,12}(\.\d{1,2})?$/)
    amount!: string;

    @IsString()
    @MinLength(3)
    @MaxLength(120)
    reference!: string;

    @IsObject()
    proof!: Record<string, unknown>;
}
