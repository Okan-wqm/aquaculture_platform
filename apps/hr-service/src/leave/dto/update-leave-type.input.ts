import { InputType, Field, ID, Int, Float } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { LeaveCategory } from '../entities/leave-type.entity';

/**
 * Input for UpdateLeaveType mutation.
 *
 * `id` identifies the target row; every other field is optional so the FE can
 * send a partial patch. Only provided keys are applied by UpdateLeaveTypeHandler
 * (undefined keys are left untouched). `code` is intentionally NOT updatable —
 * it is the stable per-tenant business key referenced by balances/requests.
 */
@InputType()
export class UpdateLeaveTypeInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @Length(1, 100)
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field(() => LeaveCategory, { nullable: true })
  @IsEnum(LeaveCategory)
  @IsOptional()
  category?: LeaveCategory;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isAccrued?: boolean;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  defaultDaysPerYear?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxCarryOverDays?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  maxConsecutiveDays?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  minDaysNotice?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  accrualRate?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  accrualStartAfterMonths?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  requiresApproval?: boolean;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  approvalLevels?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isAquacultureSpecific?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  applicableForOffshore?: boolean;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a #RRGGBB hex value' })
  color?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
