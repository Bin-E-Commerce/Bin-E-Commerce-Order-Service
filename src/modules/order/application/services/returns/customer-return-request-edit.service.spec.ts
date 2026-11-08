/// <reference types="jest" />

// File này kiểm tra customer không thể đổi request hợp lệ sang một lý do đã ngừng nhận.

import { BadRequestException } from '@nestjs/common';
import { OrderEventsService } from '@/modules/order/application/services/order/order-events.service';
import type { ReturnRequestEditRepositoryPort } from '@/modules/order/application/contracts/return-request-edit.repository';
import { OrderReturnReason } from '@/database/returns/enums/order-return-reason.enum';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { CustomerReturnRequestEditService } from '@/modules/order/application/services/returns/customer-return-request-edit.service';

describe('CustomerReturnRequestEditService', () => {
    // Request hợp lệ làm nền để kiểm tra đường sửa không thể thêm OTHER qua gọi service trực tiếp.
    it('rejects changing a standard return request to OTHER', async () => {
        const repository: ReturnRequestEditRepositoryPort = {
            findForCustomerEdit: jest.fn().mockResolvedValue({
                id: 'return-1',
                status: OrderReturnStatus.REQUESTED,
                reason: OrderReturnReason.DAMAGED,
            }),
            updateRequested: jest.fn(),
        } as unknown as ReturnRequestEditRepositoryPort;
        const events = {
            publishReturnChanged: jest.fn(),
        } as unknown as OrderEventsService;
        const service = new CustomerReturnRequestEditService(
            repository,
            events,
        );

        await expect(
            service.update('customer-1', 'return-1', {
                expectedUpdatedAt: '2026-11-08T00:00:00.000Z',
                reason: OrderReturnReason.OTHER,
                evidence: [
                    {
                        assetId: 'asset-1',
                        url: 'https://cdn.test/evidence.webp',
                        type: 'image',
                    },
                ],
            }),
        ).rejects.toThrow(BadRequestException);

        expect(repository.updateRequested).not.toHaveBeenCalled();
    });

    // Cho phép khách lưu yêu cầu CHANGE_OF_MIND với mảng evidence rỗng.
    it('updates a change-of-mind return without evidence', async () => {
        const snapshot = {
            id: 'return-1',
            orderId: 'order-1',
            orderNumber: 'BIN-0001',
            ownerId: 'customer-1',
            shopId: 'shop-1',
            sellerUserId: 'seller-1',
            status: OrderReturnStatus.REQUESTED,
            updatedAt: '2026-11-08T00:00:00.000Z',
            itemIds: ['item-1'],
            reason: OrderReturnReason.CHANGE_OF_MIND,
            description: null,
            evidence: [],
            refundItemAmount: '100000.00',
            returnShippingEstimatedCost: '11943.00',
            order: {
                subtotal: '300000.00',
                shippingFee: '30000.00',
                totalAmount: '330000.00',
                items: [
                    {
                        id: 'item-1',
                        sellerShopId: 'shop-1',
                        lineTotal: '100000.00',
                    },
                ],
            },
        };
        const repository: ReturnRequestEditRepositoryPort = {
            findForCustomerEdit: jest.fn().mockResolvedValue(snapshot),
            updateRequested: jest.fn().mockResolvedValue({
                kind: 'UPDATED',
                snapshot: {
                    id: snapshot.id,
                    orderId: snapshot.orderId,
                    orderNumber: snapshot.orderNumber,
                    ownerId: snapshot.ownerId,
                    shopId: snapshot.shopId,
                    sellerUserId: snapshot.sellerUserId,
                    status: snapshot.status,
                    refundAmount: '88057.00',
                    reason: OrderReturnReason.CHANGE_OF_MIND,
                    description: null,
                    updatedAt: snapshot.updatedAt,
                },
            }),
        } as unknown as ReturnRequestEditRepositoryPort;
        const events = {
            publishReturnChanged: jest.fn().mockResolvedValue(undefined),
        } as unknown as OrderEventsService;
        const service = new CustomerReturnRequestEditService(
            repository,
            events,
        );

        await service.update('customer-1', 'return-1', {
            expectedUpdatedAt: snapshot.updatedAt,
            reason: OrderReturnReason.CHANGE_OF_MIND,
            evidence: [],
        });

        expect(repository.updateRequested).toHaveBeenCalledWith(
            expect.objectContaining({
                reason: OrderReturnReason.CHANGE_OF_MIND,
                evidence: [],
                returnShippingPayer: 'CUSTOMER',
            }),
        );
    });

    // Đổi lý do phải tính lại cả phí giao ban đầu, payer chiều về và tổng dự kiến theo cùng một chính sách server-side.
    it.each([
        [
            OrderReturnReason.CHANGE_OF_MIND,
            OrderReturnReason.DAMAGED,
            '0.00',
            'CUSTOMER',
            '88057.00',
        ],
        [
            OrderReturnReason.DAMAGED,
            OrderReturnReason.CHANGE_OF_MIND,
            '10000.00',
            'SELLER',
            '110000.00',
        ],
    ] as const)(
        'recalculates refund and payer when changing to %s',
        async (
            reason,
            originalReason,
            refundShippingAmount,
            returnShippingPayer,
            estimatedRefundAmount,
        ) => {
            const evidence = [
                {
                    assetId: 'asset-1',
                    url: 'https://cdn.test/evidence.webp',
                    type: 'image' as const,
                },
            ];
            const snapshot = {
                id: 'return-1',
                orderId: 'order-1',
                orderNumber: 'BIN-0001',
                ownerId: 'customer-1',
                shopId: 'shop-1',
                sellerUserId: 'seller-1',
                status: OrderReturnStatus.REQUESTED,
                updatedAt: '2026-11-08T00:00:00.000Z',
                itemIds: ['item-1'],
                reason: originalReason,
                description: null,
                evidence,
                refundItemAmount: '100000.00',
                returnShippingEstimatedCost: '11943.00',
                order: {
                    subtotal: '300000.00',
                    shippingFee: '30000.00',
                    totalAmount: '330000.00',
                    items: [
                        {
                            id: 'item-1',
                            sellerShopId: 'shop-1',
                            lineTotal: '100000.00',
                        },
                    ],
                },
            };
            const repository: ReturnRequestEditRepositoryPort = {
                findForCustomerEdit: jest.fn().mockResolvedValue(snapshot),
                updateRequested: jest.fn().mockResolvedValue({
                    kind: 'UPDATED',
                    snapshot: {
                        id: snapshot.id,
                        orderId: snapshot.orderId,
                        orderNumber: snapshot.orderNumber,
                        ownerId: snapshot.ownerId,
                        shopId: snapshot.shopId,
                        sellerUserId: snapshot.sellerUserId,
                        status: snapshot.status,
                        refundAmount: estimatedRefundAmount,
                        reason,
                        description: null,
                        updatedAt: snapshot.updatedAt,
                    },
                }),
            } as unknown as ReturnRequestEditRepositoryPort;
            const events = {
                publishReturnChanged: jest.fn().mockResolvedValue(undefined),
            } as unknown as OrderEventsService;
            const service = new CustomerReturnRequestEditService(
                repository,
                events,
            );

            await service.update('customer-1', 'return-1', {
                expectedUpdatedAt: snapshot.updatedAt,
                reason,
                evidence,
            });

            expect(repository.updateRequested).toHaveBeenCalledWith(
                expect.objectContaining({
                    reason,
                    refundItemAmount: '100000.00',
                    refundShippingAmount,
                    estimatedRefundAmount,
                    returnShippingPayer,
                }),
            );
        },
    );
});
