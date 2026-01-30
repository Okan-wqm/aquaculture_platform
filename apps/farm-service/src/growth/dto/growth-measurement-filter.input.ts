/**
 * GrowthMeasurement Filter Input DTO
 *
 * Input type for filtering and querying growth measurements.
 * Supports filtering by various criteria with pagination.
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsDate,
  IsEnum,
  IsNumber,
  IsInt,
  IsBoolean,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MeasurementType,
  MeasurementMethod,
  GrowthPerformance,
} from '../entities/growth-measurement.entity';

/**
 * Sort field options for growth measurements
 */
export enum GrowthMeasurementSortField {
  MEASUREMENT_DATE = 'measurementDate',
  CREATED_AT = 'createdAt',
  AVERAGE_WEIGHT = 'averageWeight',
  SAMPLE_SIZE = 'sampleSize',
  WEIGHT_CV = 'weightCV',
  ESTIMATED_BIOMASS = 'estimatedBiomass',
}

/**
 * Sort direction
 */
export enum SortDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

@InputType()
export class GrowthMeasurementFilterInput {
  // -------------------------------------------------------------------------
  // ENTITY FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by Batch ID' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => [ID], { nullable: true, description: 'Filter by multiple Batch IDs' })
  @IsOptional()
  @IsUUID('4', { each: true })
  batchIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Filter by Tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by Pond ID' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by Site ID' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  // -------------------------------------------------------------------------
  // TYPE AND METHOD FILTERS
  // -------------------------------------------------------------------------

  @Field(() => MeasurementType, { nullable: true, description: 'Filter by measurement type' })
  @IsOptional()
  @IsEnum(MeasurementType)
  measurementType?: MeasurementType;

  @Field(() => [MeasurementType], { nullable: true, description: 'Filter by multiple measurement types' })
  @IsOptional()
  @IsEnum(MeasurementType, { each: true })
  measurementTypes?: MeasurementType[];

  @Field(() => MeasurementMethod, { nullable: true, description: 'Filter by measurement method' })
  @IsOptional()
  @IsEnum(MeasurementMethod)
  measurementMethod?: MeasurementMethod;

  // -------------------------------------------------------------------------
  // DATE RANGE FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Start date for measurement date range' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  fromDate?: Date;

  @Field({ nullable: true, description: 'End date for measurement date range' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  toDate?: Date;

  @Field({ nullable: true, description: 'Start date for created at range' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdAfter?: Date;

  @Field({ nullable: true, description: 'End date for created at range' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdBefore?: Date;

  // -------------------------------------------------------------------------
  // WEIGHT FILTERS
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // SAMPLE SIZE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true, description: 'Minimum sample size' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minSampleSize?: number;

  @Field(() => Int, { nullable: true, description: 'Maximum sample size' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSampleSize?: number;

  // -------------------------------------------------------------------------
  // PERFORMANCE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => GrowthPerformance, { nullable: true, description: 'Filter by performance rating' })
  @IsOptional()
  @IsEnum(GrowthPerformance)
  performance?: GrowthPerformance;

  @Field(() => [GrowthPerformance], { nullable: true, description: 'Filter by multiple performance ratings' })
  @IsOptional()
  @IsEnum(GrowthPerformance, { each: true })
  performanceIn?: GrowthPerformance[];

  // -------------------------------------------------------------------------
  // CV AND UNIFORMITY FILTERS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Maximum weight CV (for uniform batches)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxWeightCV?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum weight CV (for variable batches)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minWeightCV?: number;

  // -------------------------------------------------------------------------
  // FCR FILTERS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Minimum FCR' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minFCR?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum FCR' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxFCR?: number;

  // -------------------------------------------------------------------------
  // USER FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by user who performed measurement' })
  @IsOptional()
  @IsUUID()
  measuredBy?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by user who verified' })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;

  // -------------------------------------------------------------------------
  // STATUS FILTERS
  // -------------------------------------------------------------------------

  @Field(() => Boolean, { nullable: true, description: 'Filter by verification status' })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Filter by processing status' })
  @IsOptional()
  @IsBoolean()
  isProcessed?: boolean;

  // -------------------------------------------------------------------------
  // SEARCH
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Search in notes' })
  @IsOptional()
  @IsString()
  searchNotes?: string;

  // -------------------------------------------------------------------------
  // SORTING
  // -------------------------------------------------------------------------

  @Field(() => String, {
    nullable: true,
    defaultValue: 'measurementDate',
    description: 'Field to sort by',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field(() => String, {
    nullable: true,
    defaultValue: 'DESC',
    description: 'Sort direction (ASC or DESC)',
  })
  @IsOptional()
  @IsString()
  sortDirection?: 'ASC' | 'DESC';

  // -------------------------------------------------------------------------
  // PAGINATION
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true, defaultValue: 50, description: 'Maximum number of results' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Number of results to skip' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  // -------------------------------------------------------------------------
  // INCLUDE OPTIONS
  // -------------------------------------------------------------------------

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Include individual measurements in response',
  })
  @IsOptional()
  @IsBoolean()
  includeIndividualMeasurements?: boolean;

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Include statistics details in response',
  })
  @IsOptional()
  @IsBoolean()
  includeStatistics?: boolean;

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Include FCR analysis in response',
  })
  @IsOptional()
  @IsBoolean()
  includeFCRAnalysis?: boolean;
}
