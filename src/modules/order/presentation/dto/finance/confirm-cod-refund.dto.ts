// DTO xác nhận admin đã chuyển khoản hoàn COD bên ngoài; amount phải khớp snapshot hoàn đã tính phía server.
import { IsString, Matches } from 'class-validator';

// Chỉ nhận số tiền snapshot; danh tính admin và thời điểm xác nhận được backend ghi tự động.
export class ConfirmCodRefundDto {
    @IsString()
    @Matches(/^\d{1,12}(\.\d{1,2})?$/)
    amount!: string;
}
