/**
 * UpdateHarvestRecordInput DTO
 *
 * GraphQL input type for updating harvest records.
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsUUID, IsOptional, IsString, IsEnum, IsPositive, IsNumber } from 'class-validator';
import { HarvestRecordStatus, QualityGrade } from '../entities/harvest-record.entity';
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
  @IsPositive()
  quantityHarvested?: number;

  @Field(() => Float, { nullable: true, description: 'Update total biomass (kg)' })
  @IsOptional()
  @IsPositive()
  totalBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Update average weight (grams)' })
  @IsOptional()
  @IsPositive()
  averageWeight?: number;

  @Field(() => QualityGrade, { nullable: true, description: 'Update quality grade' })
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

  @Field(() => Float, { nullable: true, description: 'Update total revenue' })
  @IsOptional()
  @IsNumber()
  totalRevenue?: number;

  @Field(() => Float, { nullable: true, description: 'Update harvest cost' })
  @IsOptional()
  @IsNumber()
  harvestCost?: number;

  @Field({ nullable: true, description: 'Update currency' })
  @IsOptional()
  @IsString()
  currency?: string;

  @Field(() => Int, { nullable: true, description: 'Update mortality during harvest' })
  @IsOptional()
  mortalityDuringHarvest?: number;

  @Field(() => Float, { nullable: true, description: 'Update rejected quantity' })
  @IsOptional()
  rejectedQuantity?: number;

  @Field({ nullable: true, description: 'Update rejection reason' })
  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @Field({ nullable: true, description: 'Update notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
