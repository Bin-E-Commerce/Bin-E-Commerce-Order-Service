// DTO ví finance chỉ nhận số tiền và metadata hành động; shop, trạng thái và audit actor do backend quyết định.
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
    IsUUID,
    IsBoolean,
} from 'class-validator';

export class CreateWalletDepositDto {
    @IsString()
    @Matches(/^\d{1,10}$/)
    amount!: string;
}

export class CreateWalletWithdrawalDto {
    @IsString()
    @Matches(/^\d{1,10}$/)
    amount!: string;
}

export class AdminWalletWithdrawalActionDto {
    @IsOptional()
    @IsBoolean()
    manualTransferAcknowledged?: boolean;

    @IsOptional()
    @IsBoolean()
    recipientConfirmed?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    reference?: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string;
}

export class CreateFinanceSettlementBatchDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @IsUUID('4', { each: true })
    ledgerIds!: string[];

    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    note?: string;
}
