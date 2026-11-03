// DTO xác nhận admin đã chuyển khoản hoàn bên ngoài; số tiền phải khớp snapshot do Order Service tính.
import { IsString, Matches } from 'class-validator';

// Chỉ nhận số tiền snapshot để backend đối chiếu, không nhận mã giao dịch hoặc chứng từ từ browser.
export class ConfirmManualRefundDto {
    @IsString()
    @Matches(/^\d{1,12}(\.\d{1,2})?$/)
    amount!: string;
}
