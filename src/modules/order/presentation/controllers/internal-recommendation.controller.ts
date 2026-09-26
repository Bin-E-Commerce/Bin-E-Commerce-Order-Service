import {
    Body,
    Controller,
    Headers,
    Post,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';

// Internal replay boundary chỉ phát completed purchase snapshot, không trả payment/address data cho Recommendation.
@Controller('internal/recommendation')
export class InternalRecommendationController {
    constructor(
        private readonly config: ConfigService,
        private readonly events: OrderEventsService,
    ) {}

    // Replay có checkpoint page/pageSize và eventId ổn định theo order để chạy lại an toàn.
    @Post('purchases/replay')
    replayPurchases(
        @Body() body: { page?: number; pageSize?: number },
        // Token được Gateway/service mesh inject; không nhận token từ request body của client.
        @Headers('x-internal-service-token') token?: string,
    ) {
        const expected = this.config.get<string>('INTERNAL_SERVICE_TOKEN', '');
        if (!expected || token !== expected)
            throw new UnauthorizedException('Invalid internal service token.');
        return this.events.replayCompletedPurchases(
            body.page ?? 1,
            body.pageSize ?? 100,
        );
    }
}
