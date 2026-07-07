/**
 * Harvest Filter Input DTO
 *
 * GraphQL input types for filtering and paginating harvest records.
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Int, ID, Float } from '@nestjs/graphql';
import {
  IsOptional,
  IsUUID,
  IsEnum,
  IsString,
  IsInt,
  IsNumber,
  IsArray,
  Min,
  IsDate,
  IsBoolean,
  IsNotEmpty,
  MaxLength,
  Matches,
} from 'class-validator';
import { StandardPaginationInput } from '@aquaculture/backend-common/pagination';
import { Type } from 'class-transformer';
import { HarvestRecordStatus, QualityClass, QualityGrade } from '../entities/harvest-record.entity';
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

  @Field(() => [ID], { nullable: true, description: 'Filter by multiple batch IDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  batchIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Filter by tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => [ID], { nullable: true, description: 'Filter by multiple tank IDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tankIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Filter by pond ID' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by site ID' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => HarvestRecordStatus, { nullable: true, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(HarvestRecordStatus)
  status?: HarvestRecordStatus;

  @Field(() => [HarvestRecordStatus], { nullable: true, description: 'Filter by multiple statuses' })
  @IsOptional()
  @IsArray()
  @IsEnum(HarvestRecordStatus, { each: true })
  statuses?: HarvestRecordStatus[];

  @Field(() => QualityClass, { nullable: true, description: 'Filter by Norwegian quality class' })
  @IsOptional()
  @IsEnum(QualityClass)
  qualityClass?: QualityClass;

  @Field(() => [QualityClass], {
    nullable: true,
    description: 'Filter by multiple Norwegian quality classes',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(QualityClass, { each: true })
  qualityClasses?: QualityClass[];

  @Field(() => QualityGrade, {
    nullable: true,
    description: 'DEPRECATED — filter by legacy display grade (mapped to quality class)',
  })
  @IsOptional()
  @IsEnum(QualityGrade)
  qualityGrade?: QualityGrade;

  @Field(() => [QualityGrade], {
    nullable: true,
    description: 'DEPRECATED — filter by multiple legacy display grades (mapped to quality class)',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(QualityGrade, { each: true })
  qualityGrades?: QualityGrade[];

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
  @Type(() => Date)
  startDate?: Date;

  @Field({ nullable: true, description: 'Filter harvests until this date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @Field({ nullable: true, description: 'Filter by quality approval status' })
  @IsOptional()
  @IsBoolean()
  qualityApproved?: boolean;

  @Field(() => ID, { nullable: true, description: 'Filter by user who performed harvest' })
  @IsOptional()
  @IsUUID()
  harvestedBy?: string;

  @Field({ nullable: true, description: 'Search in record code, lot number, or notes' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @Field(() => Float, { nullable: true, description: 'Minimum total biomass (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum total biomass (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum average weight (grams)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minAverageWeight?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum average weight (grams)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAverageWeight?: number;

  @Field(() => Int, { nullable: true, description: 'Minimum quantity harvested' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minQuantity?: number;

  @Field(() => Int, { nullable: true, description: 'Maximum quantity harvested' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxQuantity?: number;
}

/**
 * Pagination input for harvest queries
 */
@InputType('HarvestPaginationInput')
export class HarvestPaginationInput extends StandardPaginationInput {
  @Field({ nullable: true, defaultValue: 'harvestDate', description: 'Field to sort by' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'sortBy must be a valid field name' })
  sortBy?: string;
}

/**
 * Date range input for statistics
 */
@InputType()
export class DateRangeInput {
  @Field({ description: 'Start date of the range' })
  @IsNotEmpty()
  @IsDate()
  @Type(() => Date)
  startDate!: Date;

  @Field({ description: 'End date of the range' })
  @IsNotEmpty()
  @IsDate()
  @Type(() => Date)
  endDate!: Date;
}
