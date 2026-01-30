/**
 * Harvest Filter Input DTO
 *
 * GraphQL input types for filtering and paginating harvest records.
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Int, ID, Float } from '@nestjs/graphql';
import { IsOptional, IsUUID, IsEnum, IsString, IsInt, Min, Max, IsDate, IsBoolean } from 'class-validator';
import { HarvestRecordStatus, QualityGrade } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';

/**
 * Filter input for harvest records
 */
@InputType()
export class HarvestFilterInput {
  @Field(() => ID, { nullable: true, description: 'Filter by batch ID' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => HarvestRecordStatus, { nullable: true, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(HarvestRecordStatus)
  status?: HarvestRecordStatus;

  @Field(() => QualityGrade, { nullable: true, description: 'Filter by quality grade' })
  @IsOptional()
  @IsEnum(QualityGrade)
  qualityGrade?: QualityGrade;

  @Field(() => HarvestMethod, { nullable: true, description: 'Filter by harvest method' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  method?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, description: 'Filter by product form' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  @Field({ nullable: true, description: 'Filter harvests from this date' })
  @IsOptional()
  @IsDate()
  startDate?: Date;

  @Field({ nullable: true, description: 'Filter harvests until this date' })
  @IsOptional()
  @IsDate()
  endDate?: Date;

  @Field({ nullable: true, description: 'Filter by quality approval status' })
  @IsOptional()
  @IsBoolean()
  qualityApproved?: boolean;

  @Field({ nullable: true, description: 'Search in record code, lot number, or notes' })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => Float, { nullable: true, description: 'Minimum total biomass (kg)' })
  @IsOptional()
  minBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum total biomass (kg)' })
  @IsOptional()
  maxBiomass?: number;
}

/**
 * Pagination input for harvest queries
 */
@InputType()
export class HarvestPaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Items per page' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field({ nullable: true, defaultValue: 'harvestDate', description: 'Field to sort by' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC', description: 'Sort direction (ASC or DESC)' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * Date range input for statistics
 */
@InputType()
export class DateRangeInput {
  @Field({ description: 'Start date of the range' })
  @IsDate()
  startDate: Date;

  @Field({ description: 'End date of the range' })
  @IsDate()
  endDate: Date;
}
