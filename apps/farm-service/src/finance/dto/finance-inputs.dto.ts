/**
 * Finance mutation inputs. Manual entries carry NO currency field — every
 * entry is booked in the tenant default currency resolved from
 * finance_settings (the currency SSoT), so the ledger is structurally
 * single-currency and cross-currency aggregation is impossible. The tenant
 * default itself is validated against the supported-currency registry.
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';
import { IsSupportedCurrency } from './is-supported-currency.validator';

@InputType()
export class CreateFinanceEntryInput {
  @Field(() => ID)
  @IsUUID()
  categoryId!: string;

  @Field()
  @IsDateString()
  entryDate!: string;

  @Field(() => Float)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @Field({ nullable: true })
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}

@InputType()
export class UpdateFinanceEntryInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @Field({ nullable: true })
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}

@InputType()
export class CreateFinanceCategoryInput {
  @Field()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Field(() => FinanceCategoryScope)
  scope!: FinanceCategoryScope;

  @Field(() => FinanceCategoryKind, { nullable: true })
  @IsOptional()
  kind?: FinanceCategoryKind;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  displayOrder?: number;
}

@InputType()
export class UpdateFinanceCategoryInput {
  @Field({ nullable: true })
  @IsOptional()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  // Activation state is NOT editable here — archival is TENANT_ADMIN-only
  // via archiveFinanceCategory / restoreFinanceCategory, so a MODULE_MANAGER
  // cannot archive a category by side-channel through this mutation.
}

@InputType()
export class UpdateFinanceSettingsInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsSupportedCurrency()
  defaultCurrency?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;
}
