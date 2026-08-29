// File này định nghĩa response public của order, tách khỏi TypeORM entity và dữ liệu kỹ thuật nội bộ.

import { OrderStatus } from "../enums/order-status.enum";
import { PaymentMethod } from "../enums/payment-method.enum";

// Contract trả về sau khi tạo hoặc đọc một order thuộc user hiện tại.
export interface OrderResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  subtotal: string;
  shippingFee: string;
  totalAmount: string;
  note: string | null;
  shippingAddress: Record<string, string>;
  items: OrderItemResponse[];
  warnings: string[];
  createdAt: string;
}

// Item response chỉ chứa snapshot cần để người mua kiểm tra lại đơn.
export interface OrderItemResponse {
  id: string;
  productId: string;
  variantId: string;
  sellerShopId: string | null;
  sku: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}
