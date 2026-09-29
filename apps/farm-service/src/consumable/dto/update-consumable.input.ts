/**
 * Update Consumable Input DTO
 */
import { InputType, Field, ID, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsIn, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateConsumableInput } from './create-consumable.input';
import {
  ConsumableCategory,
  ConsumableStatus,
  CONSUMABLE_CLIENT_SETTABLE_STATUSES,
} from '../entities/consumable.entity';

/** Schema description of the lifecycle-only status input (FARM-HIGH-337). */
export const CONSUMABLE_STATUS_INPUT_DESCRIPTION =
  'Lifecycle status. Accepts AVAILABLE or DISCONTINUED. AVAILABLE clears a lifecycle ' +
  'override: the stock band (AVAILABLE / LOW_STOCK / OUT_OF_STOCK) is then derived from ' +
  'storage-ledger stock and minStock. LOW_STOCK and OUT_OF_STOCK are rejected.';
export const CONSUMABLE_STATUS_INPUT_MESSAGE =
  'status accepts only AVAILABLE or DISCONTINUED; LOW_STOCK and OUT_OF_STOCK are derived from stock movements';

@InputType()
export class UpdateConsumableInput extends PartialType(CreateConsumableInput) {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

  @Field(() => ConsumableCategory, { nullable: true })
  @IsOptional()
  @IsEnum(ConsumableCategory)
  category?: ConsumableCategory;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  // WHY (FARM-HIGH-337): stock bands are derived from the ledger, so only the
  // lifecycle vocabulary (plus AVAILABLE = "clear the override") is accepted.
  @Field(() => ConsumableStatus, {
    nullable: true,
    description: CONSUMABLE_STATUS_INPUT_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(CONSUMABLE_CLIENT_SETTABLE_STATUSES, { message: CONSUMABLE_STATUS_INPUT_MESSAGE })
  status?: ConsumableStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
