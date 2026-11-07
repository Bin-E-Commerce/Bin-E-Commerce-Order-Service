// Port đọc và cập nhật request hoàn hàng trong một adapter persistence có khóa trạng thái.

import type {
    ReturnRequestEditSnapshot,
    ReturnRequestEditWrite,
    ReturnRequestEditWriteResult,
} from '@/modules/order/application/types/returns/return-request-edit.type';

export const RETURN_REQUEST_EDIT_REPOSITORY = Symbol(
    'RETURN_REQUEST_EDIT_REPOSITORY',
);

export interface ReturnRequestEditRepositoryPort {
    findForCustomerEdit(
        ownerId: string,
        returnId: string,
    ): Promise<ReturnRequestEditSnapshot | null>;
    updateRequested(
        input: ReturnRequestEditWrite,
    ): Promise<ReturnRequestEditWriteResult>;
}
