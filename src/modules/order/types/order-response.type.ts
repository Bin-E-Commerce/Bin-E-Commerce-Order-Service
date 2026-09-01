// File này định nghĩa response public của order, tách khỏi TypeORM entity và dữ liệu kỹ thuật nội bộ.

import { OrderStatus } from "../../../database/order/enums/order-status.enum";
import { PaymentMethod } from "../../../database/order/enums/payment-method.enum";
import { OrderFulfillmentStatus } from "../../../database/order/enums/order-fulfillment-status.enum";
import { PaymentStatus } from "../../../database/order/enums/payment-status.enum";
import { OrderDeliveryConfirmationMethod } from "../../../database/delivery/enums/order-delivery-confirmation-method.enum";
import { OrderDeliveryConfirmationStatus } from "../../../database/delivery/enums/order-delivery-confirmation-status.enum";

// Contract trả về sau khi tạo hoặc đọc một order thuộc user hiện tại.
export interface OrderResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  paymentStatus?: PaymentStatus;
  paymentMethod: PaymentMethod;
  subtotal: string;
  shippingFee: string;
  totalAmount: string;
  shippingFeeBreakdown: Array<Record<string, unknown>>;
  note: string | null;
  shippingAddress: Record<string, unknown>;
  items: OrderItemResponse[];
  cancelReason: string | null;
  cancelledAt: string | null;
  statusHistory: OrderStatusHistoryResponse[];
  warnings: string[];
  createdAt: string;
  completedAt: string | null;
  deliveryConfirmation: OrderDeliveryConfirmationResponse;
}

export interface OrderDeliveryConfirmationResponse {
  status: OrderDeliveryConfirmationStatus;
  method: OrderDeliveryConfirmationMethod | null;
  deliveredAt: string | null;
  deadline: string | null;
}

// Summary nhẹ dùng cho danh sách để không tải snapshot chi tiết không cần thiết.
export interface OrderListItemResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  paymentStatus?: PaymentStatus;
  paymentMethod: PaymentMethod;
  totalAmount: string;
  itemCount: number;
  previewItems: OrderListPreviewItemResponse[];
  createdAt: string;
}

// Preview nhỏ của snapshot sản phẩm để card lịch sử có ảnh và tên mà không gọi detail từng order.
export interface OrderListPreviewItemResponse {
  productId?: string;
  variantId?: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  quantity: number;
}

// Metadata phân trang do Order Service tính từ dữ liệu thuộc owner hiện tại.
export interface OrderListResponse {
  items: OrderListItemResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: CustomerOrderTabCounts;
}

// Số lượng đơn theo từng nhóm nghiệp vụ, được tính trên toàn bộ order của owner để badge không phụ thuộc trang đang mở.
export interface CustomerOrderTabCounts {
  all: number;
  pendingPayment: number;
  toShip: number;
  shipping: number;
  delivered: number;
  completed: number;
  cancelled: number;
  returnRefund: number;
}

// Summary Seller chỉ chứa item thuộc shop hiện tại và không leak tổng tiền của các shop khác trong cùng order.
export interface SellerOrderListItemResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  paymentStatus?: PaymentStatus;
  paymentMethod: PaymentMethod;
  shopItemTotal: string;
  shippingFee: string;
  shippingFeeBreakdown: Array<Record<string, unknown>>;
  itemCount: number;
  previewItems: SellerOrderPreviewItemResponse[];
  createdAt: string;
}

// Preview nhẹ dùng cho card Seller để hiển thị ảnh, tên và số lượng mà không cần gọi detail.
export interface SellerOrderPreviewItemResponse {
  productId: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  quantity: number;
  lineTotal: string;
}

// Response phân trang Seller được tính trên các order có ít nhất một item thuộc shop hiện tại.
export interface SellerOrderListResponse {
  items: SellerOrderListItemResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Chi tiết Seller chỉ map item của shop, giữ nguyên snapshot giao hàng và timeline order cấp hệ thống.
export interface SellerOrderResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  shopItemTotal: string;
  shippingFee: string;
  shippingFeeBreakdown: Array<Record<string, unknown>>;
  shippingAddress: Record<string, unknown>;
  items: SellerOrderItemResponse[];
  cancelReason: string | null;
  cancelledAt: string | null;
  statusHistory: OrderStatusHistoryResponse[];
  createdAt: string;
}

// Item Seller được loại bỏ sellerShopId và SKU nội bộ vì shop scope đã được kiểm tra ở server.
export interface SellerOrderItemResponse {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

// Timeline public chỉ trả các thay đổi trạng thái, không lộ owner hay khóa nội bộ.
export interface OrderStatusHistoryResponse {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  reason: string;
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
