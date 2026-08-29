// File này chứa các contract HTTP tối thiểu giữa Order Service và service sở hữu dữ liệu.
// Các type chỉ mô tả boundary, không import entity của Cart, Auth hoặc Product Service.

export interface ActiveCartResponse {
  id: string;
  ownerId: string;
  status: "ACTIVE";
  items: ActiveCartItem[];
}

export interface ActiveCartItem {
  productId: string;
  variantId: string;
  sellerShopId: string | null;
  sku: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  unitPrice: string;
  quantity: number;
}

export interface ShippingAddressResponse {
  id: string;
  label: string;
  fullName: string;
  phone: string;
  province: string;
  district: string;
  ward: string;
  street: string;
}

export interface CheckoutQuoteItem {
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

export interface CheckoutReservationResponse {
  reservationKey: string;
  items: CheckoutQuoteItem[];
}

export interface ReservationLine {
  variantId: string;
  quantity: number;
}
