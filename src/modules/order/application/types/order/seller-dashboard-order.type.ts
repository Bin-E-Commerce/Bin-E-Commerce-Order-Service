// Contract read-only cho Seller Service lấy số liệu vận hành từ Order Service.
// Contract này chỉ chứa dữ liệu đã scope theo shop, không expose order của shop khác.

import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderStatus } from '@/database/order/enums/order-status.enum';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';

export interface SellerDashboardOrderSummary {
    grossRevenue: number;
    orderCount: number;
}

export interface SellerDashboardRevenuePoint {
    date: string;
    grossRevenue: number;
    orderCount: number;
}

export interface SellerDashboardOrderStatusCounts {
    all: number;
    pendingConfirmation: number;
    pendingShipment: number;
    shipping: number;
    delivered: number;
    completed: number;
    cancelled: number;
    returnRefund: number;
}

export interface SellerDashboardLatestOrder {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    fulfillmentStatus: OrderFulfillmentStatus;
    grossAmount: number;
    itemCount: number;
    itemLineCount: number;
    returnReason?: OrderReturnReason | null;
    returnDescription?: string | null;
    cancelReason?: string | null;
    items: SellerDashboardOrderItem[];
    createdAt: string;
}

export interface SellerDashboardOrderItem {
    productId: string;
    name: string;
    thumbnailUrl: string | null;
    quantity: number;
    lineTotal: number;
}

export interface SellerDashboardTopProduct {
    productId: string;
    name: string;
    thumbnailUrl: string | null;
    quantitySold: number;
    revenue: number;
}

export interface SellerDashboardOrderSnapshot {
    current: SellerDashboardOrderSummary;
    previous: SellerDashboardOrderSummary;
    revenueTrend: SellerDashboardRevenuePoint[];
    orderStatusCounts: SellerDashboardOrderStatusCounts;
    pendingReturns: number;
    latestOrders: SellerDashboardLatestOrder[];
    recentReturnOrders: SellerDashboardLatestOrder[];
    recentReturnOrdersHasMore: boolean;
    actionableOrders: SellerDashboardLatestOrder[];
    actionableOrdersHasMore: boolean;
    cancelledOrders: SellerDashboardLatestOrder[];
    cancelledOrdersHasMore: boolean;
    deliveredOrders: SellerDashboardLatestOrder[];
    deliveredOrdersHasMore: boolean;
    completedOrders: SellerDashboardLatestOrder[];
    completedOrdersHasMore: boolean;
    topProductsTotalCount: number;
    topProductsHasMore: boolean;
    topProducts: SellerDashboardTopProduct[];
}
