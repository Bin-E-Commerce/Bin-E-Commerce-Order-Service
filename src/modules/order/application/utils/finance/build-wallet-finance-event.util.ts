// Tạo envelope bất biến cho chuyển trạng thái ví seller sang Notification Service.
import type {
    WalletFinanceEventName,
    WalletFinanceChangedEvent,
    WalletFinanceChangedPayload,
} from '@common/kafka/events';

// Gắn ID ổn định theo loại sự kiện và giao dịch để outbox/consumer có thể loại trùng khi retry.
export function buildWalletFinanceEvent(
    eventName: WalletFinanceEventName,
    aggregateId: string,
    data: WalletFinanceChangedPayload,
): WalletFinanceChangedEvent {
    return {
        eventId: `${eventName}:${aggregateId}`,
        eventName,
        eventVersion: 1,
        source: 'order-service',
        occurredAt: new Date().toISOString(),
        aggregateId,
        data,
    };
}
