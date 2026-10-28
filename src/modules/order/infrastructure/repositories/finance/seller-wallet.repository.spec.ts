// Kiểm thử các bất biến số dư payout trước/sau chuyển khoản; khóa pessimistic được yêu cầu ở bước giữ chỗ.
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { Order } from '@/database/order/entities/order.entity';
import { OrderFulfillmentStatus } from '@/database/order/enums/order-fulfillment-status.enum';
import { PaymentMethod } from '@/database/order/enums/payment-method.enum';
import { PaymentStatus } from '@/database/order/enums/payment-status.enum';
import { SellerWallet } from '@/database/payment/entities/seller-wallet.entity';
import { SellerWalletLedger } from '@/database/payment/entities/seller-wallet-ledger.entity';
import { WalletWithdrawalRequest } from '@/database/payment/entities/wallet-withdrawal-request.entity';
import { PlatformFinanceLedger } from '@/database/payment/entities/platform-finance-ledger.entity';
import { OrderReturnRequest } from '@/database/returns/entities/order-return-request.entity';
import { OrderReturnStatus } from '@/database/returns/enums/order-return-status.enum';
import { SellerWalletRepository } from '@/modules/order/infrastructure/repositories/finance/seller-wallet.repository';

describe('SellerWalletRepository completed-order release', () => {
    // COD chỉ vào available sau khi admin xác nhận đã đối soát; trước đó không được chạy truy vấn release.
    it('keeps COD proceeds pending until remittance is confirmed', async () => {
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'order-1',
                paymentMethod: PaymentMethod.COD,
                paymentStatus: PaymentStatus.PAID,
                fulfillmentStatus: OrderFulfillmentStatus.COMPLETED,
                codRemittedAt: null,
            }),
        };
        const manager = {
            getRepository: jest.fn().mockReturnValue(orderRepository),
            query: jest.fn().mockResolvedValue([]),
        } as unknown as EntityManager;
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await repository.releaseCompletedOrder('order-1');

        expect(manager.query).not.toHaveBeenCalled();
    });

    // Sau xác nhận COD, reconcile và release chỉ nhắm order này, đồng thời cả hai query giữ predicate đối soát.
    it('releases COD proceeds only after the admin marks them remitted', async () => {
        const orderRepository = {
            findOne: jest.fn().mockResolvedValue({
                id: 'order-1',
                paymentMethod: PaymentMethod.COD,
                paymentStatus: PaymentStatus.PAID,
                fulfillmentStatus: OrderFulfillmentStatus.COMPLETED,
                codRemittedAt: new Date(),
            }),
        };
        const queryMock = jest.fn().mockResolvedValue([]);
        const manager = {
            getRepository: jest.fn((entity: Function) =>
                entity === Order ? orderRepository : undefined,
            ),
            query: queryMock,
        } as unknown as EntityManager;
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await repository.releaseCompletedOrder('order-1');

        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(queryMock.mock.calls[0]![0]).toEqual(
            expect.stringContaining('order_row.cod_remitted_at IS NOT NULL'),
        );
        expect(queryMock.mock.calls[0]![1]).toEqual([
            null,
            'order-1',
            PaymentStatus.PAID,
            PaymentMethod.COD,
        ]);
        expect(queryMock.mock.calls[1]![0]).toEqual(
            expect.stringContaining('order_row.cod_remitted_at IS NOT NULL'),
        );
        expect(queryMock.mock.calls[1]![1]).toEqual(['order-1']);
    });
});

// Lập EntityManager theo đúng repository token để test giữ nguyên transaction boundary của adapter.
function createManager(repositories: Map<Function, Record<string, jest.Mock>>) {
    return {
        getRepository: (entity: Function) => repositories.get(entity),
    } as unknown as EntityManager;
}

// Chạy callback transaction với manager giả để có thể kiểm tra số dư và ledger cùng một thao tác.
function createDataSource(manager: EntityManager): DataSource {
    return {
        transaction: jest.fn(
            async (callback: (value: EntityManager) => unknown) =>
                callback(manager),
        ),
    } as unknown as DataSource;
}

describe('SellerWalletRepository withdrawals', () => {
    // Minima là 10.000 VND; persistence dùng cents nên giá trị thấp hơn phải bị từ chối trước khi mở transaction.
    it('rejects deposits and withdrawals below 10,000 VND', async () => {
        const repository = new SellerWalletRepository({} as DataSource);

        await expect(
            repository.createWalletDeposit({
                shopId: 'shop-1',
                sellerUserId: 'seller-1',
                amount: '9999.99',
                merchantReference: 'WREF-1',
                expiresAt: new Date(),
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            repository.requestWithdrawal({
                shopId: 'shop-1',
                sellerUserId: 'seller-1',
                amount: '9999.99',
                bankCode: 'MB',
                bankName: 'MB Bank',
                accountHolder: 'NGUYEN VAN A',
                accountNumber: '12345678',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Giữ chỗ trừ khả dụng và cộng reserved cùng transaction; request lưu snapshot ngân hàng nhưng chỉ trả masked account.
    it('reserves the requested amount and requests a pessimistic wallet lock', async () => {
        const wallet = {
            shopId: 'shop-1',
            availableBalance: '20000.00',
            reservedBalance: '0.00',
        };
        const walletRepository = {
            findOne: jest.fn().mockResolvedValue(wallet),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const withdrawalRepository = {
            save: jest.fn().mockImplementation(async (value) => ({
                ...value,
                id: 'withdrawal-1',
                createdAt: new Date('2026-10-18T00:00:00.000Z'),
                processedAt: null,
            })),
        };
        const ledgerRepository = { save: jest.fn() };
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [SellerWallet, walletRepository],
                [WalletWithdrawalRequest, withdrawalRepository],
                [SellerWalletLedger, ledgerRepository],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        const result = await repository.requestWithdrawal({
            shopId: 'shop-1',
            sellerUserId: 'seller-1',
            amount: '10000',
            bankCode: 'MB',
            bankName: 'MB Bank',
            accountHolder: 'NGUYEN VAN A',
            accountNumber: '12345678',
        });

        expect(walletRepository.findOne).toHaveBeenCalledWith({
            where: { shopId: 'shop-1' },
            lock: { mode: 'pessimistic_write' },
        });
        expect(wallet).toMatchObject({
            availableBalance: '10000.00',
            reservedBalance: '10000.00',
        });
        expect(result.accountNumberMasked).toBe('****5678');
        expect(result).not.toHaveProperty('accountNumber');
        expect(ledgerRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'WITHDRAWAL_RESERVED',
                amount: '-10000.00',
                sourceKey: 'withdrawal:withdrawal-1:reserve',
            }),
        );
    });

    // Thiếu balance hoặc race thắng bởi request khác bị từ chối trước khi tạo payout hay ledger.
    it('rejects a withdrawal larger than the currently available balance', async () => {
        const walletRepository = {
            findOne: jest.fn().mockResolvedValue({
                shopId: 'shop-1',
                availableBalance: '10000.00',
                reservedBalance: '0.00',
            }),
            save: jest.fn(),
        };
        const withdrawalRepository = { save: jest.fn() };
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [SellerWallet, walletRepository],
                [WalletWithdrawalRequest, withdrawalRepository],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await expect(
            repository.requestWithdrawal({
                shopId: 'shop-1',
                sellerUserId: 'seller-1',
                amount: '20000',
                bankCode: 'MB',
                bankName: 'MB Bank',
                accountHolder: 'NGUYEN VAN A',
                accountNumber: '12345678',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(withdrawalRepository.save).not.toHaveBeenCalled();
    });

    // Webhook chỉ stage giao dịch; admin xác nhận người nhận mới tất toán và retry không ghi ledger lần hai.
    it('stages and confirms a Pay2S payout exactly once', async () => {
        const wallet = {
            shopId: 'shop-1',
            availableBalance: '10000.00',
            reservedBalance: '10000.00',
        };
        const withdrawal = {
            id: 'withdrawal-1',
            shopId: 'shop-1',
            amount: '10000.00',
            status: 'PROCESSING',
            transferReference: null,
            pay2sTransactionId: null,
            pay2sTransactionNumber: null,
            pay2sTransferAmount: null,
            pay2sTransferDetectedAt: null,
            recipientConfirmedBy: null,
            recipientConfirmedAt: null,
            adminNote: null,
        };
        const walletRepository = {
            findOne: jest.fn().mockResolvedValue(wallet),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const withdrawalRepository = {
            findOne: jest
                .fn()
                .mockImplementation(
                    async (options: {
                        where: { pay2sTransactionId?: string };
                    }) =>
                        options.where.pay2sTransactionId ? null : withdrawal,
                ),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const walletLedgerRepository = { save: jest.fn() };
        const platformLedgerRepository = { save: jest.fn() };
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [SellerWallet, walletRepository],
                [WalletWithdrawalRequest, withdrawalRepository],
                [SellerWalletLedger, walletLedgerRepository],
                [PlatformFinanceLedger, platformLedgerRepository],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        const firstResult = await repository.stagePay2sWithdrawalTransfer({
            withdrawalId: 'withdrawal-1',
            amount: '10000.00',
            providerTransactionId: 'PAY2S-EVENT-1',
            transactionNumber: 'BANK-TRANSFER-1',
        });
        const retryResult = await repository.stagePay2sWithdrawalTransfer({
            withdrawalId: 'withdrawal-1',
            amount: '10000.00',
            providerTransactionId: 'PAY2S-EVENT-1',
            transactionNumber: 'BANK-TRANSFER-1',
        });
        const confirmResult = await repository.confirmPay2sWithdrawalTransfer({
            withdrawalId: 'withdrawal-1',
            adminId: 'admin-1',
        });

        expect(firstResult).toBe('STAGED');
        expect(retryResult).toBe('DUPLICATE');
        expect(confirmResult).toBe('PAID');
        expect(wallet.reservedBalance).toBe('0.00');
        expect(withdrawal.status).toBe('PAID');
        expect(walletLedgerRepository.save).toHaveBeenCalledTimes(1);
        expect(walletLedgerRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'WITHDRAWAL_PAID',
                amount: '0.00',
            }),
        );
        expect(platformLedgerRepository.save).toHaveBeenCalledTimes(1);
        expect(platformLedgerRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'SELLER_PAYOUT',
                amount: '-10000.00',
                reference: 'BANK-TRANSFER-1',
                createdBy: 'admin-1',
            }),
        );
    });
});

describe('SellerWalletRepository return-shipping receivables', () => {
    // Only a finalized customer-paid fee on a failed inspection becomes a receivable, and retry must reuse its source key.
    it('records an outstanding customer fee once without treating it as collected cash', async () => {
        const request = {
            id: 'return-1',
            shopId: 'shop-1',
            orderId: 'order-1',
            status: OrderReturnStatus.INSPECTION_FAILED,
            returnShippingPayer: 'CUSTOMER',
            returnShippingFinalizedAt: new Date(),
            returnShippingCost: '12000.00',
        };
        const receivableLedger = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn(),
        };
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [
                    OrderReturnRequest,
                    { findOne: jest.fn().mockResolvedValue(request) },
                ],
                [PlatformFinanceLedger, receivableLedger],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await repository.recordCustomerReturnShippingReceivable(
            'return-1',
            '12000.00',
        );

        expect(receivableLedger.save).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE',
                amount: '12000.00',
                sourceKey: 'return-shipping-receivable:return-1',
                returnRequestId: 'return-1',
            }),
        );
    });

    // An amount must not be claimed from a customer unless the carrier fee is finalized and the seller rejected the refund.
    it('rejects receivable creation before an inspection failure', async () => {
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [
                    OrderReturnRequest,
                    {
                        findOne: jest.fn().mockResolvedValue({
                            id: 'return-1',
                            status: OrderReturnStatus.RECEIVED,
                            returnShippingPayer: 'CUSTOMER',
                            returnShippingFinalizedAt: new Date(),
                            returnShippingCost: '12000.00',
                        }),
                    },
                ],
                [PlatformFinanceLedger, { save: jest.fn() }],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await expect(
            repository.recordCustomerReturnShippingReceivable(
                'return-1',
                '12000.00',
            ),
        ).rejects.toThrow('shop từ chối hoàn tiền');
    });
});

describe('SellerWalletRepository return-shipping charges', () => {
    // Shop chỉ bị trừ một lần khi GHN đã chốt phí; retry callback tìm thấy source key cũ và không trừ thêm.
    it('debits seller wallet once for a seller-paid return fee', async () => {
        const wallet = {
            shopId: 'shop-1',
            availableBalance: '50000.00',
        };
        let savedPlatformEntry: Record<string, unknown> | null = null;
        const walletRepository = {
            findOne: jest.fn().mockResolvedValue(wallet),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const sellerLedgerRepository = { save: jest.fn() };
        const platformLedgerRepository = {
            findOne: jest
                .fn()
                .mockImplementation(async () => savedPlatformEntry),
            save: jest.fn().mockImplementation(async (value) => {
                savedPlatformEntry = value;
                return value;
            }),
        };
        const manager = {
            getRepository: jest.fn((entity: Function) => {
                if (entity === OrderReturnRequest)
                    return {
                        findOne: jest.fn().mockResolvedValue({
                            id: 'return-1',
                            shopId: 'shop-1',
                            orderId: 'order-1',
                            returnShippingPayer: 'SELLER',
                        }),
                    };
                if (entity === PlatformFinanceLedger)
                    return platformLedgerRepository;
                if (entity === SellerWallet) return walletRepository;
                if (entity === SellerWalletLedger)
                    return sellerLedgerRepository;
                return undefined;
            }),
            query: jest.fn().mockResolvedValue(undefined),
        } as unknown as EntityManager;
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await repository.recordReturnShippingFee('return-1', '12000.00');
        await repository.recordReturnShippingFee('return-1', '12000.00');

        expect(wallet.availableBalance).toBe('38000.00');
        expect(walletRepository.save).toHaveBeenCalledTimes(1);
        expect(sellerLedgerRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'RETURN_SHIPPING_DEBIT',
                amount: '-12000.00',
                sourceKey: 'return-shipping:return-1',
            }),
        );
        expect(sellerLedgerRepository.save).toHaveBeenCalledTimes(1);
    });
});

describe('SellerWalletRepository settlement batches', () => {
    // Receivable chưa thu không phải dòng tiền ngân hàng và phải bị từ chối khỏi đợt đối soát cash.
    it('does not include outstanding customer return fees in cash reconciliation', async () => {
        const queryBuilder = {
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([
                {
                    id: 'ledger-1',
                    settlementBatchId: null,
                    kind: 'CUSTOMER_RETURN_SHIPPING_RECEIVABLE',
                },
            ]),
        };
        const manager = createManager(
            new Map<Function, Record<string, jest.Mock>>([
                [
                    PlatformFinanceLedger,
                    { createQueryBuilder: jest.fn(() => queryBuilder) },
                ],
            ]),
        );
        const repository = new SellerWalletRepository(
            createDataSource(manager),
        );

        await expect(
            repository.createSettlementBatch({
                adminId: 'admin-1',
                ledgerIds: ['ledger-1'],
            }),
        ).rejects.toThrow('chưa trả không thể ghép');
    });
});
