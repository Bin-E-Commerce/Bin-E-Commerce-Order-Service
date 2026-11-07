// Client nội bộ yêu cầu Seller Service khóa/mở shop theo trạng thái công nợ đã xác nhận.
import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SellerFinanceLockClient {
    private readonly targetBase: string;
    private readonly internalServiceToken: string;

    // Dùng cùng địa chỉ Seller Service và shared token của các tích hợp nội bộ.
    constructor(config: ConfigService) {
        this.targetBase = config.get<string>(
            'SELLER_SERVICE_URL',
            'http://localhost:3007',
        );
        this.internalServiceToken = config.get<string>(
            'INTERNAL_SERVICE_TOKEN',
            '',
        );
    }

    // Gọi endpoint nội bộ có shared token; lỗi mạng/upstream được ném để worker thử lại, không đánh dấu đồng bộ giả.
    async setShopFinanceLock(shopId: string, locked: boolean): Promise<void> {
        if (!this.internalServiceToken)
            throw new BadGatewayException(
                'Thiếu cấu hình xác thực nội bộ Seller Service.',
            );

        let response: Response;
        try {
            response = await fetch(
                `${this.targetBase}/api/v1/internal/seller/shops/${shopId}/finance-lock`,
                {
                    method: 'PUT',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        'x-internal-service-token': this.internalServiceToken,
                    },
                    body: JSON.stringify({ locked }),
                    signal: AbortSignal.timeout(5_000),
                },
            );
        } catch {
            throw new BadGatewayException(
                'Không thể đồng bộ trạng thái khóa shop lúc này.',
            );
        }

        if (!response.ok)
            throw new BadGatewayException(
                'Seller Service chưa cập nhật được trạng thái khóa shop.',
            );
    }
}
