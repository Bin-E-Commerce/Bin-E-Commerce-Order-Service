// DTO xác nhận admin đã chuyển khoản hoàn bên ngoài; số tiền phải khớp snapshot do Order Service tính.
import {
    IsObject,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

// Bắt buộc mã ngân hàng và bằng chứng để việc xác nhận có thể đối soát, retry và truy vết sau này.
export class ConfirmManualRefundDto {
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
