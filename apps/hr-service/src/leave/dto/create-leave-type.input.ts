import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { LeaveCategory } from '../entities/leave-type.entity';

/**
 * Input for CreateLeaveType mutation.
 *
 * Field set mirrors the LeaveType entity's @Column surface (the FE LeaveTypeFull
 * fragment in web/modules/hr-module/src/graphql/fragments.ts reads these back).
 * Server-managed fields (id, tenantId, audit columns, version, soft-delete) are
 * intentionally NOT writable here.
 */
@InputType()
export class CreateLeaveTypeInput {
  @Field()
  @IsString()
  @Length(1, 100)
  name!: string;

  @Field()
  @IsString()
  // Codes are the per-tenant unique key (@Index(['tenantId','code'], unique)).
  // Constrain to an uppercase token so two visually distinct codes cannot collide.
  @Matches(/^[A-Z0-9_]{1,20}$/, {
    message: 'code must be 1-20 uppercase letters, digits or underscores',
  })
  code!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @Field(() => LeaveCategory, { defaultValue: LeaveCategory.ANNUAL })
  @IsEnum(LeaveCategory)
  @IsOptional()
  category?: LeaveCategory;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @Field({ defaultValue: true })
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

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  accrualStartAfterMonths?: number;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  requiresApproval?: boolean;

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  approvalLevels?: number;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isAquacultureSpecific?: boolean;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  applicableForOffshore?: boolean;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a #RRGGBB hex value' })
  color?: string;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
