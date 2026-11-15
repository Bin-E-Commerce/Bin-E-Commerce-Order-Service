// Chuẩn hóa response Pay2S thành các trường an toàn mà màn hình Customer cần dùng.
import { Order } from '@/database/order/entities/order.entity';
import { PaymentAttempt } from '@/database/payment/entities/payment-attempt.entity';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import type { Pay2sCustomerPaymentDetails } from '@/modules/order/application/types/payments/pay2s-customer-payment.type';
import { PAY2S_ORDER_PAYMENT_TTL_MS } from '@/modules/order/application/constants/payments/pay2s.constants';

// Chỉ nhận chuỗi không rỗng để response JSON/provider không đưa kiểu dữ liệu lạ ra UI.
function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Link QR và fallback chỉ được trả khi là HTTPS từ domain Pay2S, tránh biến response lưu DB thành open redirect.
function readPay2sUrl(value: unknown): string | null {
    const candidate = readString(value);
    if (!candidate) return null;

    try {
        const url = new URL(candidate);
        return url.protocol === 'https:' && url.hostname.endsWith('.pay2s.vn')
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

// Ánh xạ dữ liệu order/attempt sang trạng thái hiện tại; deadline luôn là timestamp đã lưu, không tạo lại khi refresh.
export function mapPay2sCustomerPaymentDetails(
    order: Order,
    attempt: PaymentAttempt | null,
): Pay2sCustomerPaymentDetails {
    // Trạng thái order/payment là nguồn sự thật; attempt chỉ phân biệt hết hạn và có thể thử lại.
    const status =
        order.paymentStatus === PaymentStatus.PAID
            ? 'PAID'
            : order.paymentStatus === PaymentStatus.REFUND_PENDING
              ? 'REFUND_PENDING'
              : order.paymentStatus === PaymentStatus.REFUNDED
                ? 'REFUNDED'
                : order.status === OrderStatus.CANCELLED
                  ? attempt?.status === 'EXPIRED'
                      ? 'EXPIRED'
                      : 'CANCELLED'
                  : attempt?.status === 'PENDING'
                    ? 'PENDING'
                    : 'RETRYABLE';

    // Chỉ đọc phần tử QR đầu tiên có cấu trúc object; các trường ngoài allowlist không được gửi xuống browser.
    const providerResponse = attempt?.providerResponse;
    const rawQrList = providerResponse?.qrList;
    const qrEntry = Array.isArray(rawQrList)
        ? rawQrList.find(
              (value): value is Record<string, unknown> =>
                  typeof value === 'object' && value !== null,
          )
        : null;
    const qrData = readString(qrEntry?.qrData);
    const alternateQrData = readString(qrEntry?.qrCode);

    // Các deadline cũ có thể còn 15 phút trong database; lấy mốc sớm nhất để UI không vượt thời gian Pay2S.
    const providerDeadline = new Date(
        order.createdAt.getTime() + PAY2S_ORDER_PAYMENT_TTL_MS,
    );
    const expiresAt = [
        attempt?.expiresAt,
        order.paymentExpiresAt,
        providerDeadline,
    ]
        .filter((value): value is Date => value instanceof Date)
        .reduce((earliest, value) => (value < earliest ? value : earliest));

    // Dùng dữ liệu QR EMV do Pay2S cấp để ngân hàng quét đúng số tiền và nội dung thực tế.
    return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.totalAmount,
        status,
        expiresAt: expiresAt.toISOString(),
        bankName:
            readString(qrEntry?.bank_name) ?? readString(qrEntry?.bank_id),
        accountHolder: readString(qrEntry?.account_name),
        accountNumber: readString(qrEntry?.account_number),
        orderInfo: readString(attempt?.providerOrderInfo),
        qrData:
            qrData ??
            (alternateQrData?.startsWith('000201') ? alternateQrData : null),
        qrUrl: readPay2sUrl(qrEntry?.qrUrl),
        paymentUrl: readPay2sUrl(providerResponse?.payUrl),
    };
}
