/**
 * UpdateHarvestRecordInput DTO
 *
 * GraphQL input type for updating harvest records.
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsString,
  IsEnum,
  IsPositive,
  IsNumber,
  IsBoolean,
  IsDateString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { HarvestRecordStatus, QualityClass, QualityGrade } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';

@InputType()
export class UpdateHarvestRecordInput {
  @Field(() => ID, { description: 'ID of the harvest record to update' })
  @IsNotEmpty()
  @IsUUID()
  id: string;

  @Field(() => HarvestRecordStatus, { nullable: true, description: 'Update status' })
  @IsOptional()
  @IsEnum(HarvestRecordStatus)
  status?: HarvestRecordStatus;

  @Field(() => Int, { nullable: true, description: 'Update quantity harvested' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(1)
  quantityHarvested?: number;

  @Field(() => Float, { nullable: true, description: 'Update total biomass (kg)' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(0.01)
  totalBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Update average weight (grams)' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(0.01)
  @Max(100000)
  averageWeight?: number;

  @Field(() => QualityClass, {
    nullable: true,
    description: 'Update Norwegian quality class (kvalitetsklasse) — the stored SSoT.',
  })
  @IsOptional()
  @IsEnum(QualityClass)
  qualityClass?: QualityClass;

  @Field(() => QualityGrade, {
    nullable: true,
    description: 'DEPRECATED legacy display grade — mapped onto qualityClass when supplied.',
  })
  @IsOptional()
  @IsEnum(QualityGrade)
  qualityGrade?: QualityGrade;

  @Field(() => HarvestMethod, { nullable: true, description: 'Update harvest method' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  method?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, description: 'Update product form' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  @Field(() => Float, { nullable: true, description: 'Update price per kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pricePerKg?: number;

  @Field(() => Float, { nullable: true, description: 'Update total revenue' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalRevenue?: number;

  @Field(() => Float, { nullable: true, description: 'Update harvest cost' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  harvestCost?: number;

  @Field({ nullable: true, description: 'Update currency' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field({ nullable: true, description: 'Update buyer name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  buyerName?: string;

  @Field({ nullable: true, description: 'Update lot number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNumber?: string;

  @Field(() => Int, { nullable: true, description: 'Update mortality during harvest' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mortalityDuringHarvest?: number;

  @Field(() => Float, { nullable: true, description: 'Update rejected quantity (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rejectedQuantity?: number;

  @Field({ nullable: true, description: 'Update rejection reason' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;

  @Field(() => Boolean, { nullable: true, description: 'Quality approval status' })
  @IsOptional()
  @IsBoolean()
  qualityApproved?: boolean;

  @Field(() => ID, { nullable: true, description: 'User ID who approved quality' })
  @IsOptional()
  @IsUUID()
  qualityApprovedBy?: string;

  @Field({ nullable: true, description: 'Quality approval date' })
  @IsOptional()
  @IsDateString()
  qualityApprovedAt?: string;

  @Field({ nullable: true, description: 'Update notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
