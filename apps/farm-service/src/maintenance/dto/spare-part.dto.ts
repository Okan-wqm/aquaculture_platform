/**
 * SparePart DTOs
 * @module Maintenance/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsBoolean,
  IsArray,
  IsIn,
  Min,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SparePartStatus } from '../entities/spare-part.entity';

/**
 * Shelf/bin text inside the part's storage location (FARM-HIGH-338). The
 * physical place itself is `storageLocationId`; this is operator detail only.
 */
@InputType()
export class SparePartBinDetailInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  warehouse?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  shelf?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bin?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Yedek parça oluşturma input
 */
@InputType()
export class CreateSparePartInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  partNumber!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentTypeId?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  compatibleEquipmentTypes?: string[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  /**
   * Stock on hand when the part is registered. Recorded as ONE opening IN
   * movement in the storage ledger at `storageLocationId` (required when > 0);
   * it is never written to a counter (FARM-HIGH-338).
   */
  @Field(() => Int, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  openingQuantity!: number;

  /** The storage location that physically holds the part. */
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  storageLocationId?: string;

  @Field(() => Int, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  minStock!: number;

  @Field(() => Int, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  maxStock!: number;

  @Field(() => Int, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  reorderPoint!: number;

  @Field({ defaultValue: 'piece' })
  @IsString()
  @MaxLength(20)
  unit!: string;

  @Field(() => SparePartBinDetailInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SparePartBinDetailInput)
  binDetail?: SparePartBinDetailInput;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @Field({ defaultValue: 'TRY' })
  @IsString()
  @MaxLength(3)
  currency!: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  leadTimeDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Yedek parça güncelleme input
 */
@InputType()
export class UpdateSparePartInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  partNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentTypeId?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  compatibleEquipmentTypes?: string[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string;

  // NO quantity and NO status here (FARM-HIGH-337/338): stock changes only
  // through ledger movements, and the status is derived from the ledger.

  /**
   * Re-home the part: the location its future movements default to. `null`
   * clears it (stock already booked stays where the ledger says it is).
   */
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  storageLocationId?: string | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxStock?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reorderPoint?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @Field(() => SparePartBinDetailInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SparePartBinDetailInput)
  binDetail?: SparePartBinDetailInput;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  leadTimeDays?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * The operator movements of one spare part. `transfer` relocates stock between
 * two storage locations (FARM-HIGH-338: the ledger's TRANSFER movement).
 */
export const SPARE_PART_MOVEMENT_TYPES = ['in', 'out', 'adjustment', 'transfer'] as const;
export type SparePartMovementType = (typeof SPARE_PART_MOVEMENT_TYPES)[number];

/**
 * Stok hareketi input
 */
@InputType()
export class StockMovementInput {
  @Field(() => ID)
  @IsUUID()
  sparePartId!: string;

  /**
   * in/out/transfer: the amount moved (> 0). adjustment: the counted on-hand at
   * the location (>= 0).
   */
  @Field(() => Int)
  @IsNumber()
  @Min(0)
  quantity!: number;

  // Explicit String: the field's TypeScript type is a literal union derived from
  // SPARE_PART_MOVEMENT_TYPES, which reflection cannot name for GraphQL.
  @Field(() => String, { description: 'in | out | adjustment | transfer' })
  @IsIn(SPARE_PART_MOVEMENT_TYPES)
  movementType!: SparePartMovementType;

  /**
   * The storage location the movement acts at (the SOURCE of a transfer).
   * Defaults to the part's own `storageLocationId`; one of the two is required.
   */
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  storageLocationId?: string;

  /**
   * transfer only: the storage location that receives the stock. WHY here and
   * not on `transferStock`: spare-part stock moves only through this
   * manager-gated door, into the one ledger sink (lock, site checks on both
   * legs, low-stock tiers) — see TRANSFERABLE_ITEM_TYPES.
   */
  @Field(() => ID, { nullable: true })
  @ValidateIf((input: StockMovementInput) => input.movementType === 'transfer')
  @IsUUID()
  toStorageLocationId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  reason?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  workOrderId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Yedek parça filtreleme input
 */
@InputType()
export class SparePartFilterInput {
  @Field(() => [SparePartStatus], { nullable: true })
  @IsOptional()
  @IsEnum(SparePartStatus, { each: true })
  status?: SparePartStatus[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentTypeId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  manufacturer?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Derived status LOW_STOCK: ledger on-hand + open orders at or below reorderPoint',
  })
  @IsOptional()
  @IsBoolean()
  isLowStock?: boolean;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Derived status OUT_OF_STOCK: ledger on-hand 0',
  })
  @IsOptional()
  @IsBoolean()
  isOutOfStock?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}
