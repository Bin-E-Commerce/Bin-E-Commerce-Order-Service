/// <reference types="jest" />

// File này kiểm tra các quy tắc tạo và tính toán của workflow hoàn hàng.

import { type DeepMocked } from '@golevelup/ts-jest';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { OrderRepository } from '@/modules/order/infrastructure/repositories/orders/order.repository';
import { SellerShopClient } from '@/modules/order/application/clients/seller-shop.client';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import { ShippingClient } from '@/modules/order/application/clients/shipping.client';
import type { AuthClient } from '@/modules/order/application/clients/auth.client';
import { OrderReturnService } from '@/modules/order/application/services/returns/order-return.service';

describe('OrderReturnService', () => {
    let service: OrderReturnService;
    let returns: DeepMocked<Repository<OrderReturnRequest>>;
    let orders: DeepMocked<OrderRepository>;
    let shops: DeepMocked<SellerShopClient>;
    let events: DeepMocked<OrderEventsService>;
    let shipping: DeepMocked<ShippingClient>;

    const refundBankAccountId = '1b4e28ba-2fa1-4d2a-883f-0016d3cca427';

    const orderData = {
        id: 'order-1',
        ownerId: 'customer-1',
        orderNumber: 'BIN-0001',
        // Ca tạo return mới dùng DELIVERED vì khách chưa xác nhận hoàn thành đơn.
        fulfillmentStatus: OrderFulfillmentStatus.DELIVERED,
        returnWindowUntil: new Date(Date.now() + 86_400_000),
        shippingFee: '30000.00',
        subtotal: '300000.00',
        shippingAddress: {
            fullName: 'Nguyễn Văn A',
            phone: '0900000000',
            street: '123 Đường Test',
            province: 'Hồ Chí Minh',
            district: 'Quận 1',
            ward: 'Phường Bến Nghé',
            ghnAddress: {
                provinceId: 202,
                districtId: 1442,
                wardCode: '20101',
                districtName: 'Quận 1',
                wardName: 'Phường Bến Nghé',
            },
        },
        items: [
            {
                id: 'item-1',
                sellerShopId: 'shop-1',
                sellerOwnerId: 'seller-1',
                lineTotal: '100000.00',
                quantity: 1,
                packageWeightGrams: 500,
                packageLengthCm: '20',
                packageWidthCm: '15',
                packageHeightCm: '10',
            },
            {
                id: 'item-2',
                sellerShopId: 'shop-2',
                sellerOwnerId: 'seller-2',
                lineTotal: '200000.00',
                quantity: 1,
                packageWeightGrams: 500,
                packageLengthCm: '20',
                packageWidthCm: '15',
                packageHeightCm: '10',
            },
        ],
    };
    const order = orderData as never;

    beforeEach(async () => {
        returns = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
        } as unknown as DeepMocked<Repository<OrderReturnRequest>>;
        orders = {
            findOwnedById: jest.fn(),
        } as unknown as DeepMocked<OrderRepository>;
        shops = {
            getOwnedShopId: jest.fn(),
        } as unknown as DeepMocked<SellerShopClient>;
        events = {
            publishReturnChanged: jest.fn(),
        } as unknown as DeepMocked<OrderEventsService>;
        shipping = {
            calculateQuote: jest.fn(),
            getReturnShipmentState: jest.fn().mockResolvedValue(null),
        } as unknown as DeepMocked<ShippingClient>;
        shipping.calculateQuote.mockResolvedValue({ fee: '11942.86' } as never);
        const auth = {
            getOwnedRefundBankAccount: jest.fn().mockResolvedValue({
                id: refundBankAccountId,
                bankCode: 'vietcombank',
                bankName: 'Vietcombank',
                accountHolder: 'NGUYEN VAN A',
                accountNumber: '0123456789',
            }),
        } as unknown as AuthClient;
        service = new OrderReturnService(
            returns,
            orders,
            shops,
            events,
            shipping,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            auth,
        );
        orders.findOwnedById.mockResolvedValue(order);
        const savedRequest = {} as OrderReturnRequest;
        (returns as any).create = jest.fn((value: OrderReturnRequest) =>
            Object.assign(savedRequest, value),
        );
        (returns as any).save = jest.fn(async () => savedRequest);
    });

    it('creates a seller-fault return with proportional shipping refund', async () => {
        await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.DAMAGED,
            evidence: [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image',
                },
            ],
        });

        const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
        expect(persisted.status).toBe(OrderReturnStatus.REQUESTED);
        expect(persisted.refundAmount).toBe('110000.00');
        expect(persisted.estimatedRefundAmount).toBe('110000.00');
        expect(persisted.refundItemAmount).toBe('100000.00');
        expect(persisted.refundShippingAmount).toBe('10000.00');
        expect(persisted.returnShippingEstimatedCost).toBe('11943.00');
        expect(persisted.returnShippingCost).toBe('0.00');
        expect(persisted.returnShippingFee).toBe('0.00');
        expect(events.publishReturnChanged).toHaveBeenCalled();
        expect(shipping.calculateQuote).toHaveBeenCalledWith(
            expect.objectContaining({
                shopId: 'shop-1',
                shipmentKind: 'RETURN',
                value: 100000,
                codAmount: 0,
            }),
        );
    });

    // Khách đổi ý không được hoàn phí shop giao ban đầu; estimate chỉ trừ phí khách → shop.
    it('does not refund outbound shipping for a change-of-mind return', async () => {
        await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            evidence: [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image',
                },
            ],
        });

        const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
        expect(persisted.refundItemAmount).toBe('100000.00');
        expect(persisted.refundShippingAmount).toBe('0.00');
        expect(persisted.returnShippingPayer).toBe('CUSTOMER');
        expect(persisted.estimatedRefundAmount).toBe('88057.00');
    });

    // GHN chốt phí trả hàng do Seller chịu thì phí được ghi cho Seller, không khấu trừ vào tiền Customer nhận lại.
    it('keeps seller-fault refund intact after seller-paid return shipping is finalized', async () => {
        const request = {
            id: 'return-1',
            orderId: 'order-1',
            ownerId: 'customer-1',
            status: OrderReturnStatus.AWAITING_SHIPMENT,
            reason: OrderReturnReason.DAMAGED,
            returnShippingPayer: 'SELLER',
            returnShippingEstimatedCost: '11943.00',
            refundItemAmount: '100000.00',
            refundShippingAmount: '10000.00',
            returnShippingFee: '0.00',
            returnShippingCost: '0.00',
            returnShippingFinalizedAt: null,
            customerReturnShippingReceivableAmount: '0.00',
            inspectionPassed: false,
            refundAmount: '110000.00',
        } as OrderReturnRequest;
        const wallet = {
            recordReturnShippingPlatformCost: jest
                .fn()
                .mockResolvedValue(undefined),
            recordReturnShippingFee: jest.fn().mockResolvedValue(undefined),
        };
        returns.findOne.mockResolvedValue(request);
        returns.save.mockResolvedValue(request);
        orders.findOwnedById.mockResolvedValue(order);
        service = new OrderReturnService(
            returns,
            orders,
            shops,
            events,
            shipping,
            undefined,
            undefined,
            wallet as never,
        );

        await service.updateReturnShippingCost('return-1', '12345.50');

        expect(request.returnShippingCost).toBe('12346.00');
        expect(request.returnShippingFee).toBe('0.00');
        expect(request.refundAmount).toBe('110000.00');
        expect(wallet.recordReturnShippingPlatformCost).toHaveBeenCalledWith(
            'return-1',
            '12346.00',
        );
        expect(wallet.recordReturnShippingFee).not.toHaveBeenCalled();
    });

    it('rounds proportional refund amounts to whole VND', async () => {
        orders.findOwnedById.mockResolvedValue({
            ...orderData,
            shippingFee: '30000.00',
            subtotal: '300000.00',
            items: [{ ...orderData.items[0], lineTotal: '100000.86' }],
        } as never);

        await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.DAMAGED,
            evidence: [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image',
                },
            ],
        });

        const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
        expect(persisted.refundItemAmount).toBe('100001.00');
        expect(persisted.refundShippingAmount).toBe('10000.00');
        expect(persisted.refundAmount).toBe('110001.00');
    });

    it('charges reverse shipping only to a customer-fault return', async () => {
        const request = {
            id: 'return-1',
            status: OrderReturnStatus.AWAITING_SHIPMENT,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            returnShippingPayer: 'CUSTOMER',
            returnShippingEstimatedCost: '11943.00',
            refundItemAmount: '100000.00',
            refundShippingAmount: '0.00',
            returnShippingFee: '0.00',
            returnShippingCost: '0.00',
            refundAmount: '100000.00',
        } as OrderReturnRequest;
        // GHN luôn ghi phí carrier vào platform ledger; customer payer không sinh debit ví Seller.
        const wallet = {
            recordReturnShippingPlatformCost: jest
                .fn()
                .mockResolvedValue(undefined),
            recordReturnShippingFee: jest.fn().mockResolvedValue(undefined),
        };
        returns.findOne.mockResolvedValue(request);
        returns.save.mockResolvedValue(request);
        service = new OrderReturnService(
            returns,
            orders,
            shops,
            events,
            shipping,
            undefined,
            undefined,
            wallet as never,
        );

        await service.updateReturnShippingCost('return-1', '12345.50');

        expect(request.returnShippingCost).toBe('12346.00');
        expect(request.returnShippingFee).toBe('12346.00');
        expect(request.refundAmount).toBe('87654.00');
        expect(request.returnShippingFinalizedAt).toBeInstanceOf(Date);
        expect(wallet.recordReturnShippingPlatformCost).toHaveBeenCalledWith(
            'return-1',
            '12346.00',
        );
        expect(wallet.recordReturnShippingFee).not.toHaveBeenCalled();
    });

    // Lý do OTHER không thể duyệt cho tới khi Seller tự phân loại payer; số hoàn được tính lại theo lựa chọn đã lưu.
    it.each([
        ['CUSTOMER', '0.00', '88057.00'],
        ['SELLER', '0.00', '100000.00'],
    ] as const)(
        'applies the selected %s return-shipping payer',
        async (returnShippingPayer, expectedFee, expectedRefund) => {
            const request = {
                id: 'return-1',
                orderId: 'order-1',
                ownerId: 'customer-1',
                shopId: 'shop-1',
                status: OrderReturnStatus.REQUESTED,
                reason: OrderReturnReason.OTHER,
                returnShippingPayer: null,
                returnShippingEstimatedCost: '11943.00',
                refundItemAmount: '100000.00',
                refundShippingAmount: '0.00',
                refundAmount: '100000.00',
            } as OrderReturnRequest;
            returns.findOne.mockResolvedValue(request);
            returns.save.mockResolvedValue(request);
            shops.getOwnedShopId.mockResolvedValue('shop-1');
            orders.findOwnedById.mockResolvedValue(null);

            const result = await service.review(
                { userId: 'seller-1', email: 'seller@example.test' } as never,
                'return-1',
                { returnShippingPayer },
                OrderReturnStatus.APPROVED,
            );

            expect(result.returnShippingPayer).toBe(returnShippingPayer);
            expect(result.returnShippingFee).toBe(expectedFee);
            expect(result.estimatedRefundAmount).toBe(expectedRefund);
            expect(result.refundAmount).toBe(expectedRefund);
            expect(result.status).toBe(OrderReturnStatus.AWAITING_SHIPMENT);
        },
    );

    // Không cho phép lý do OTHER được duyệt khi Seller bỏ trống phân loại payer.
    it('requires the seller to select a payer for OTHER before approval', async () => {
        returns.findOne.mockResolvedValue({
            id: 'return-1',
            shopId: 'shop-1',
            status: OrderReturnStatus.REQUESTED,
            reason: OrderReturnReason.OTHER,
        } as OrderReturnRequest);
        shops.getOwnedShopId.mockResolvedValue('shop-1');

        await expect(
            service.review(
                { userId: 'seller-1', email: 'seller@example.test' } as never,
                'return-1',
                {},
                OrderReturnStatus.APPROVED,
            ),
        ).rejects.toThrow('chọn bên chịu phí');

        expect(returns.save).not.toHaveBeenCalled();
    });

    // Migration cũ để OTHER ở AWAITING_SHIPMENT không được phép kẹt vĩnh viễn; seller có thể phân loại payer một lần.
    it('reopens a legacy OTHER request in AWAITING_SHIPMENT for payer review', async () => {
        const request = {
            id: 'return-legacy',
            orderId: 'order-1',
            ownerId: 'customer-1',
            shopId: 'shop-1',
            status: OrderReturnStatus.AWAITING_SHIPMENT,
            reason: OrderReturnReason.OTHER,
            returnShippingPayer: null,
            returnShippingEstimatedCost: '11943.00',
            refundItemAmount: '100000.00',
            refundShippingAmount: '0.00',
            refundAmount: '100000.00',
        } as OrderReturnRequest;
        returns.findOne.mockResolvedValue(request);
        returns.save.mockResolvedValue(request);
        shops.getOwnedShopId.mockResolvedValue('shop-1');
        orders.findOwnedById.mockResolvedValue(null);

        const result = await service.review(
            { userId: 'seller-1', email: 'seller@example.test' } as never,
            'return-legacy',
            { returnShippingPayer: 'SELLER' },
            OrderReturnStatus.APPROVED,
        );

        expect(result.returnShippingPayer).toBe('SELLER');
        expect(result.status).toBe(OrderReturnStatus.AWAITING_SHIPMENT);
        expect(result.estimatedRefundAmount).toBe('100000.00');
        expect(returns.save).toHaveBeenCalledWith(request);
    });

    // GHN quote cao hơn giá trị món hàng không được chuyển thành khoản khấu trừ lớn hơn toàn bộ tiền hoàn hàng.
    it('rejects customer-paid return shipping above the item value', async () => {
        const request = {
            id: 'return-1',
            status: OrderReturnStatus.AWAITING_SHIPMENT,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            returnShippingPayer: 'CUSTOMER',
            returnShippingEstimatedCost: '100000.00',
            refundItemAmount: '100000.00',
            refundShippingAmount: '0.00',
            returnShippingFee: '100000.00',
            refundAmount: '0.00',
        } as OrderReturnRequest;
        returns.findOne.mockResolvedValue(request);

        await expect(
            service.updateReturnShippingCost('return-1', '100001'),
        ).rejects.toThrow('cao hơn giá trị sản phẩm');
    });

    it('rejects fault returns without an image evidence', async () => {
        await expect(
            service.create('customer-1', 'order-1', {
                itemIds: ['item-1'],
                savedRefundBankAccountId: refundBankAccountId,
                reason: OrderReturnReason.WRONG_ITEM,
                evidence: [],
            }),
        ).rejects.toThrow('cần ít nhất một ảnh');
    });

    // Đổi ý không cần media; backend vẫn lưu mảng rỗng chuẩn hóa cho các màn Seller/Admin.
    it('creates a change-of-mind return without evidence', async () => {
        await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.CHANGE_OF_MIND,
        });

        const persisted = returns.save.mock.calls[0]![0] as OrderReturnRequest;
        expect(persisted.reason).toBe(OrderReturnReason.CHANGE_OF_MIND);
        expect(persisted.evidence).toEqual([]);
        expect(persisted.returnShippingPayer).toBe('CUSTOMER');
    });

    // Lớp service chặn OTHER kể cả khi một caller nội bộ bỏ qua DTO validation.
    it('rejects OTHER for a new customer return request', async () => {
        await expect(
            service.create('customer-1', 'order-1', {
                itemIds: ['item-1'],
                savedRefundBankAccountId: refundBankAccountId,
                reason: OrderReturnReason.OTHER,
                evidence: [
                    {
                        assetId: 'asset-1',
                        url: 'https://cdn.test/evidence.webp',
                        type: 'image',
                    },
                ],
            }),
        ).rejects.toThrow('Lý do khác không còn được hỗ trợ');

        expect(returns.save).not.toHaveBeenCalled();
        expect(shipping.calculateQuote).not.toHaveBeenCalled();
    });

    // Preview lỗi do shop phải cộng khoản giao ban đầu hoàn khách và quote GHN chiều về đúng một lần mỗi chiều.
    it('previews both outbound and return shipping fees for a seller-fault return', async () => {
        const request = {
            id: 'return-1',
            shopId: 'shop-1',
            status: OrderReturnStatus.REQUESTED,
            reason: OrderReturnReason.DAMAGED,
            returnShippingPayer: 'SELLER',
            refundShippingAmount: '20900.00',
            returnShippingEstimatedCost: '20900.00',
        } as OrderReturnRequest;
        const wallet = {
            getSnapshot: jest.fn().mockResolvedValue({
                availableBalance: '-18900.00',
            }),
        };
        const debtService = {
            getShopSnapshot: jest.fn().mockResolvedValue({
                debtBalance: '18900.00',
                debtLimit: '500000.00',
                shopLocked: false,
            }),
        };
        returns.findOne.mockResolvedValue(request);
        shops.getOwnedShopId.mockResolvedValue('shop-1');
        service = new OrderReturnService(
            returns,
            orders,
            shops,
            events,
            shipping,
            undefined,
            undefined,
            wallet as never,
            undefined,
            undefined,
            debtService as never,
        );

        const preview = await service.getSellerReturnFinancePreview(
            { userId: 'seller-1', email: 'seller@example.test' } as never,
            'return-1',
        );

        expect(preview.estimatedOutboundShippingFee).toBe('20900.00');
        expect(preview.estimatedReturnShippingFee).toBe('20900.00');
        expect(preview.estimatedShippingFee).toBe('41800.00');
        expect(wallet.getSnapshot).toHaveBeenCalledWith('shop-1', 1, 1);
    });

    // Bảo vệ payer của năm lý do customer được phép chọn; OTHER chỉ xử lý ở các hồ sơ lịch sử.
    it.each([
        [OrderReturnReason.DAMAGED, 'SELLER'],
        [OrderReturnReason.WRONG_ITEM, 'SELLER'],
        [OrderReturnReason.MISSING_ITEM, 'SELLER'],
        [OrderReturnReason.NOT_AS_DESCRIBED, 'SELLER'],
        [OrderReturnReason.CHANGE_OF_MIND, 'CUSTOMER'],
    ] as const)(
        'assigns the agreed return-shipping payer for %s',
        async (reason, expectedPayer) => {
            await service.create('customer-1', 'order-1', {
                itemIds: ['item-1'],
                savedRefundBankAccountId: refundBankAccountId,
                reason,
                evidence: [
                    {
                        assetId: 'asset-1',
                        url: 'https://cdn.test/evidence.webp',
                        type: 'image',
                    },
                ],
            });

            const persisted = returns.save.mock
                .calls[0]![0] as OrderReturnRequest;
            expect(persisted.returnShippingPayer).toBe(expectedPayer);
        },
    );

    // Estimate customer trả vượt giá trị sản phẩm thì chặn ngay, trước khi tạo yêu cầu hoặc khoản phí.
    it('blocks a customer-paid request when its shipping estimate exceeds item value', async () => {
        shipping.calculateQuote.mockResolvedValue({
            fee: '100001.00',
        } as never);

        // Dùng evidence hợp lệ để assertion kiểm tra riêng giới hạn phí quote.
        await expect(
            service.create('customer-1', 'order-1', {
                itemIds: ['item-1'],
                savedRefundBankAccountId: refundBankAccountId,
                reason: OrderReturnReason.CHANGE_OF_MIND,
                evidence: [
                    {
                        assetId: 'asset-1',
                        url: 'https://cdn.test/evidence.webp',
                        type: 'image',
                    },
                ],
            }),
        ).rejects.toThrow('cao hơn giá trị sản phẩm');

        expect(returns.save).not.toHaveBeenCalled();
    });

    // Khi carrier trả phí cao hơn sau lúc cấp nhãn, Order ghi REJECTED/ghi chú và phục hồi trạng thái order gốc đúng một lần.
    it('rejects an over-limit carrier fee after the canceled label and notifies both parties', async () => {
        const request = {
            id: 'return-1',
            orderId: 'order-1',
            ownerId: 'customer-1',
            shopId: 'shop-1',
            sellerUserId: null,
            status: OrderReturnStatus.AWAITING_SHIPMENT,
            returnShippingPayer: 'CUSTOMER',
            refundItemAmount: '100000.00',
            returnShippingEstimatedCost: '11943.00',
            returnShippingCost: '0.00',
            returnShippingFee: '0.00',
            returnShippingFinalizedAt: null,
            customerReturnShippingReceivableAmount: '0.00',
            reviewNote: null,
        } as OrderReturnRequest;
        const order = {
            id: 'order-1',
            orderNumber: 'BIN-0001',
            fulfillmentStatus: OrderFulfillmentStatus.RETURN_REFUND,
            deliveryConfirmationStatus: 'CONFIRMED',
        };
        const requestRepository = {
            findOne: jest.fn().mockResolvedValue(request),
            save: jest.fn(async (value) => value),
        };
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue(order),
            save: jest.fn(async (value) => value),
        };
        const manager = {
            getRepository: (entity: Function) =>
                entity === OrderReturnRequest
                    ? requestRepository
                    : orderRepository,
        };
        const dataSource = {
            transaction: jest.fn(async (callback) => callback(manager)),
        } as unknown as DataSource;
        service = new OrderReturnService(
            returns,
            orders,
            shops,
            events,
            shipping,
            dataSource,
        );

        const result = await service.rejectForReturnShippingCostLimit(
            'return-1',
            '120000.00',
        );
        await service.rejectForReturnShippingCostLimit('return-1', '120000.00');

        expect(result.status).toBe(OrderReturnStatus.REJECTED);
        expect(result.returnShippingCost).toBe('0.00');
        expect(result.returnShippingFee).toBe('0.00');
        expect(result.returnShippingFinalizedAt).toBeNull();
        expect(result.reviewNote).toContain('vận đơn đã được hủy');
        expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.COMPLETED);
        expect(orderRepository.save).toHaveBeenCalledTimes(1);
        // Chỉ ràng buộc payload nghiệp vụ; EntityManager là tham số tùy chọn của event adapter.
        expect(events.publishReturnChanged.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                eventName: 'return.rejected',
                customerUserId: 'customer-1',
                sellerUserId: null,
                status: OrderReturnStatus.REJECTED,
            }),
        );
        expect(events.publishReturnChanged).toHaveBeenCalledTimes(1);
    });

    // Request hợp lệ về evidence để lỗi được xác định bởi quy tắc một shop.
    it('rejects a request spanning multiple shops', async () => {
        await expect(
            service.create('customer-1', 'order-1', {
                itemIds: ['item-1', 'item-2'],
                savedRefundBankAccountId: refundBankAccountId,
                reason: OrderReturnReason.CHANGE_OF_MIND,
                evidence: [
                    {
                        assetId: 'asset-1',
                        url: 'https://cdn.test/evidence.webp',
                        type: 'image',
                    },
                ],
            }),
        ).rejects.toThrow('một shop');
    });

    // Retry gửi đủ payload hợp lệ rồi chỉ kiểm tra request đang mở được trả lại mà không quote/tạo mới.
    it.each([
        OrderReturnStatus.REQUESTED,
        OrderReturnStatus.AWAITING_SHIPMENT,
        OrderReturnStatus.IN_TRANSIT,
        OrderReturnStatus.RECEIVED,
    ])('returns the active request when status is %s', async (status) => {
        // Arrange
        const existingRequest = {
            id: 'return-1',
            status,
        } as OrderReturnRequest;
        returns.findOne.mockResolvedValue(existingRequest);

        // Act
        const result = await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            evidence: [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image',
                },
            ],
        });

        // Assert
        expect(result).toBe(existingRequest);
        expect(returns.save).not.toHaveBeenCalled();
        expect(shipping.calculateQuote).not.toHaveBeenCalled();
    });

    // Evidence hợp lệ để mô phỏng race ở unique index sau khi request mới đã qua validation.
    it('returns the request created by a concurrent insert', async () => {
        // Arrange
        const concurrentRequest = {
            id: 'return-2',
            status: OrderReturnStatus.REQUESTED,
        } as OrderReturnRequest;
        returns.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(concurrentRequest);
        const driverError = Object.assign(
            new Error('duplicate active return'),
            {
                code: '23505',
                constraint: 'uq_order_return_active_order_shop',
            },
        );
        const uniqueViolation = new QueryFailedError('INSERT', [], driverError);
        returns.save.mockRejectedValue(uniqueViolation);

        // Act
        const result = await service.create('customer-1', 'order-1', {
            itemIds: ['item-1'],
            savedRefundBankAccountId: refundBankAccountId,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            evidence: [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image',
                },
            ],
        });

        // Assert
        expect(result).toBe(concurrentRequest);
        expect(returns.save).toHaveBeenCalledTimes(1);
        expect(returns.findOne).toHaveBeenCalledTimes(2);
    });
});
