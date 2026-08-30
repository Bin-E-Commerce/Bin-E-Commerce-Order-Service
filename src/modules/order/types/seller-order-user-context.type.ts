// Context Seller được dựng từ header do Gateway xác thực; Order Service không nhận shopId từ client.
export interface SellerOrderUserContext {
  userId: string;
  email: string;
  permissions: string[];
}
