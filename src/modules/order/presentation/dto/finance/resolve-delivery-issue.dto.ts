// DTO để admin phân xử khiếu nại giao hàng chưa có yêu cầu trả hàng đi kèm.
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

// Quyết định REFUND tạo khoản hoàn chờ chuyển; REJECT trả đơn về bước customer xác nhận giao hàng.
export class ResolveDeliveryIssueDto {
    @IsIn(['REFUND', 'REJECT'])
    decision!: 'REFUND' | 'REJECT';

    @IsString()
    @MinLength(10)
    @MaxLength(500)
    note!: string;
}
