/**
 * HR finance mutation inputs. Entries carry NO currency field — every
 * entry is booked in the tenant default currency resolved through
 * PayrollCostSettingsService (event-projected from the farm
 * finance_settings SSoT), so the HR ledger is structurally single-currency.
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

@InputType()
export class CreateHrFinanceEntryInput {
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
  departmentHrId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

@InputType()
export class UpdateHrFinanceEntryInput {
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
  departmentHrId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

@InputType()
export class CreateHrFinanceCategoryInput {
  @Field()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  displayOrder?: number;
}

@InputType()
export class UpdateHrFinanceCategoryInput {
  @Field({ nullable: true })
  @IsOptional()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  // Activation state is NOT editable here — archival/restoral is
  // TENANT_ADMIN-only via archiveHrFinanceCategory / restoreHrFinanceCategory.
}

/**
 * Fund percentages are tenant-configurable; defaultCurrency is NOT here
 * by design — it is projected from the farm finance settings SSoT.
 */
@InputType()
export class UpdatePayrollCostSettingsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  pensionFundPct?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  socialInsurancePct?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  medicalInsurancePct?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  otherCostPct?: number;
}
