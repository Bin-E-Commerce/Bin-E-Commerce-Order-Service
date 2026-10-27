// Kiểm tra DTO của endpoint nội bộ khớp toàn bộ query string mà Seller Service gửi qua ValidationPipe.
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InternalVariantSalesQueryDto } from '@/modules/order/presentation/dto/internal/internal-variant-sales-query.dto';

describe('InternalVariantSalesQueryDto', () => {
    // shopId phải được khai báo và validate để whitelist không từ chối query trước khi controller chạy.
    it('accepts the complete seller variant-sales query with strict whitelist validation', async () => {
        const query = plainToInstance(InternalVariantSalesQueryDto, {
            shopId: 'd9428888-122b-4f5a-9b20-7a5e13258f39',
            variantIds:
                'd9428888-122b-4f5a-9b20-7a5e13258f40,d9428888-122b-4f5a-9b20-7a5e13258f41',
            from: '2026-09-11T00:00:00.000Z',
            to: '2026-10-11T00:00:00.000Z',
        });

        const errors = await validate(query, {
            whitelist: true,
            forbidNonWhitelisted: true,
        });

        expect(errors).toEqual([]);
        expect(query.variantIds).toEqual([
            'd9428888-122b-4f5a-9b20-7a5e13258f40',
            'd9428888-122b-4f5a-9b20-7a5e13258f41',
        ]);
    });
});
