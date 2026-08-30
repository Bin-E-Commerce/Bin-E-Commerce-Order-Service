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
  cancelReason: string | null;
  cancelledAt: string | null;
  statusHistory: OrderStatusHistoryResponse[];
  warnings: string[];
  createdAt: string;
}

// Summary nhẹ dùng cho danh sách để không tải snapshot chi tiết không cần thiết.
export interface OrderListItemResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  totalAmount: string;
  itemCount: number;
  previewItems: OrderListPreviewItemResponse[];
  createdAt: string;
}

// Preview nhỏ của snapshot sản phẩm để card lịch sử có ảnh và tên mà không gọi detail từng order.
export interface OrderListPreviewItemResponse {
  productId: string;
  variantId: string;
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
}

// Summary Seller chỉ chứa item thuộc shop hiện tại và không leak tổng tiền của các shop khác trong cùng order.
export interface SellerOrderListItemResponse {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  shopItemTotal: string;
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
  paymentMethod: PaymentMethod;
  shopItemTotal: string;
  shippingAddress: Record<string, string>;
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
