/**
 * Finance mutation inputs. Currency is optional everywhere — when
 * omitted, handlers resolve the tenant default via FinanceSettingsService
 * (the currency SSoT); a hardcoded fallback literal is banned.
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';

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
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 alpha-3 code' })
  currency?: string;

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
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 alpha-3 code' })
  currency?: string;

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

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType()
export class UpdateFinanceSettingsInput {
  @Field({ nullable: true })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'defaultCurrency must be an ISO 4217 alpha-3 code' })
  defaultCurrency?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;
}
