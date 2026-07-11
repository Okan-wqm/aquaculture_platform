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
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SparePartStatus } from '../entities/spare-part.entity';

/**
 * Depolama lokasyonu input
 */
@InputType()
export class StorageLocationInput {
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

  @Field(() => Int, { defaultValue: 0 })
  @IsNumber()
  @Min(0)
  quantity!: number;

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

  @Field(() => StorageLocationInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => StorageLocationInput)
  location?: StorageLocationInput;

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

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

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

  @Field(() => SparePartStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SparePartStatus)
  status?: SparePartStatus;

  @Field(() => StorageLocationInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => StorageLocationInput)
  location?: StorageLocationInput;

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
 * Stok hareketi input
 */
@InputType()
export class StockMovementInput {
  @Field(() => ID)
  @IsUUID()
  sparePartId!: string;

  @Field(() => Int)
  @IsNumber()
  quantity!: number;

  @Field({ description: 'in | out | adjustment' })
  @IsString()
  movementType!: 'in' | 'out' | 'adjustment';

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

  @Field(() => Boolean, { nullable: true, description: 'Stok < minStock' })
  @IsOptional()
  @IsBoolean()
  isLowStock?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Stok = 0' })
  @IsOptional()
  @IsBoolean()
  isOutOfStock?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}
