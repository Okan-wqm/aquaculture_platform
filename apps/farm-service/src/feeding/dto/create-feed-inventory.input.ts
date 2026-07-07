/**
 * Create FeedInventory DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';
import { InventoryStatus } from '../entities/feed-inventory.entity';

/**
 * Create feed inventory input
 */
@InputType()
export class CreateFeedInventoryInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  siteId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  quantityKg!: number;

  @Field(() => Float, { defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStockKg?: number;

  @Field(() => InventoryStatus, { defaultValue: InventoryStatus.AVAILABLE })
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

  @Field({ nullable: true, defaultValue: 'TRY' })
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
 * Inventory movement input for stock transactions
 */
@InputType()
export class InventoryMovementInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedInventoryId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  quantityKg!: number;

  @Field()
  @IsNotEmpty()
  @IsString()
  movementType!: 'purchase' | 'consumption' | 'transfer_in' | 'transfer_out' | 'adjustment' | 'waste' | 'return' | 'expired';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  relatedFeedingRecordId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  transferToSiteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
