/**
 * Update FeedInventory DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';
import { InventoryStatus } from '../entities/feed-inventory.entity';

/**
 * Update feed inventory input
 */
@InputType()
export class UpdateFeedInventoryInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantityKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStockKg?: number;

  @Field(() => InventoryStatus, { nullable: true })
  @IsOptional()
  @IsEnum(InventoryStatus)
  status?: InventoryStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  manufacturingDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  receivedDate?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPricePerKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalValue?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  storageLocation?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  storageTemperature?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Adjust inventory quantity input
 */
@InputType()
export class AdjustInventoryQuantityInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => Float)
  @IsNumber()
  adjustmentKg!: number;

  @Field()
  @IsString()
  @MaxLength(500)
  reason!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Transfer inventory input
 */
@InputType()
export class TransferInventoryInput {
  @Field(() => ID)
  @IsUUID()
  sourceInventoryId!: string;

  @Field(() => ID)
  @IsUUID()
  targetSiteId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  targetDepartmentId?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  quantityKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
