/**
 * CreateHarvestRecordInput DTO
 *
 * GraphQL input type for creating harvest records.
 *
 * @module Harvest/DTO
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';
import { QualityClass, QualityGrade } from '../entities/harvest-record.entity';

@InputType()
export class CreateHarvestRecordInput extends MobileCommandEnvelopeInput {
  @Field(() => ID, { description: 'Batch ID' })
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field(() => ID, { description: 'Tank ID' })
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => ID, { nullable: true, description: 'Pond ID (alternative to tank)' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => Int, { description: 'Number of fish harvested' })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  @Min(1)
  quantityHarvested: number;

  @Field(() => Float, { description: 'Average weight in grams' })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  @Min(0.01)
  @Max(100000)
  averageWeight: number;

  @Field(() => Float, { description: 'Total biomass in kg' })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  @Min(0.01)
  totalBiomass: number;

  @Field(() => QualityClass, {
    nullable: true,
    description: 'Norwegian quality class (kvalitetsklasse) — the stored SSoT. Preferred input.',
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

  @Field({ description: 'Harvest date (ISO 8601 format)' })
  @IsNotEmpty()
  @IsDateString()
  harvestDate: string;

  @Field(() => HarvestMethod, { nullable: true, description: 'Harvest method used' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  method?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, description: 'Product form (whole, gutted, fillet, etc.)' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  @Field(() => Float, { nullable: true, description: 'Price per kilogram' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pricePerKg?: number;

  @Field(() => Float, { nullable: true, description: 'Total revenue from harvest' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalRevenue?: number;

  @Field(() => Float, { nullable: true, description: 'Harvest operation cost' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  harvestCost?: number;

  @Field({ nullable: true, defaultValue: 'TRY', description: 'Currency code' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field({ nullable: true, description: 'Buyer name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  buyerName?: string;

  @Field({ nullable: true, description: 'Lot number for traceability' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNumber?: string;

  @Field(() => Int, { nullable: true, description: 'Mortality count during harvest' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mortalityDuringHarvest?: number;

  @Field(() => Float, { nullable: true, description: 'Rejected quantity (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rejectedQuantity?: number;

  @Field({ nullable: true, description: 'Reason for rejection' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;

  // Harvest identity is server-derived, never client-supplied. The resolver
  // reads the authenticated principal from @CurrentUser and threads
  // user.sub into CreateHarvestRecordCommand.recordedBy, which the handler
  // persists as HarvestRecord.supervisorId and stamps onto the
  // BatchHarvested event's userId. A client-provided `harvestedBy` was never
  // read by the command interface or the handler, yet its ID! arity forced
  // every caller (mobile included) to send a value or get a 400 — a required
  // field with no consumer. Removing it makes attribution-spoofing
  // structurally impossible (tier-1) instead of merely ignored.

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
