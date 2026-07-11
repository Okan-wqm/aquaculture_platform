/**
 * CreateGrowthMeasurement Input DTO
 *
 * Input type for creating new growth measurements.
 * Includes sample data, weight/length metrics, and optional analysis fields.
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsDate,
  IsEnum,
  IsNumber,
  IsInt,
  IsString,
  IsBoolean,
  IsArray,
  ValidateNested,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  MeasurementType,
  MeasurementMethod,
} from '../entities/growth-measurement.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

/**
 * Individual measurement input for a single fish sample
 */
@InputType()
export class IndividualMeasurementInput {
  @Field(() => Int, { description: 'Sample number (1, 2, 3...)' })
  @IsInt()
  @Min(1)
  sampleNumber!: number;

  @Field(() => Float, { description: 'Weight in grams' })
  @IsNumber()
  @Min(0.01)
  @Max(100000)
  weight!: number;

  @Field(() => Float, { nullable: true, description: 'Total length in cm' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(500)
  length?: number;

  @Field(() => Float, { nullable: true, description: 'Body width in cm' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  width?: number;

  @Field({ nullable: true, description: 'Observation notes (deformity, lesion, etc.)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Measurement conditions input
 */
@InputType()
export class MeasurementConditionsInput {
  @Field(() => Float, { nullable: true, description: 'Water temperature (C)' })
  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(45)
  waterTemp?: number;

  @Field(() => Float, { nullable: true, description: 'Dissolved oxygen (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  dissolvedOxygen?: number;

  @Field({ description: 'Feeding status before measurement' })
  @IsString()
  feedingStatus!: 'fed' | 'fasted_12h' | 'fasted_24h' | 'unknown';

  @Field({ description: 'Time of day (HH:mm format)' })
  @IsString()
  @MinLength(5)
  @MaxLength(5)
  timeOfDay!: string;

  @Field({ nullable: true, description: 'Weather conditions' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  weatherConditions?: string;
}

// ============================================================================
// MAIN INPUT TYPE
// ============================================================================

@InputType()
export class CreateGrowthMeasurementInput {
  // -------------------------------------------------------------------------
  // BATCH AND LOCATION
  // -------------------------------------------------------------------------

  @Field(() => ID, { description: 'Batch ID' })
  @IsUUID()
  batchId!: string;

  @Field(() => ID, { nullable: true, description: 'Tank ID where measurement was taken' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true, description: 'Pond ID where measurement was taken' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  // -------------------------------------------------------------------------
  // MEASUREMENT INFO
  // -------------------------------------------------------------------------

  @Field({ description: 'Measurement date' })
  @IsDate()
  @Type(() => Date)
  measurementDate!: Date;

  @Field(() => MeasurementType, {
    defaultValue: MeasurementType.ROUTINE,
    description: 'Type of measurement',
  })
  @IsEnum(MeasurementType)
  measurementType!: MeasurementType;

  @Field(() => MeasurementMethod, {
    defaultValue: MeasurementMethod.MANUAL_SCALE,
    description: 'Method used for measurement',
  })
  @IsEnum(MeasurementMethod)
  measurementMethod!: MeasurementMethod;

  // -------------------------------------------------------------------------
  // SAMPLE INFO
  // -------------------------------------------------------------------------

  @Field(() => Int, { description: 'Number of fish sampled' })
  @IsInt()
  @Min(1)
  @Max(10000)
  sampleSize!: number;

  @Field(() => Int, { description: 'Total population size of batch' })
  @IsInt()
  @Min(1)
  populationSize!: number;

  // -------------------------------------------------------------------------
  // INDIVIDUAL MEASUREMENTS
  // -------------------------------------------------------------------------

  @Field(() => [IndividualMeasurementInput], {
    description: 'Individual measurement data for each sampled fish',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndividualMeasurementInput)
  individualMeasurements!: IndividualMeasurementInput[];

  // -------------------------------------------------------------------------
  // QUICK ACCESS METRICS (optional - can be auto-calculated)
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Average weight in grams (auto-calculated if not provided)' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  averageWeight?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum weight in grams' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  minWeight?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum weight in grams' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  maxWeight?: number;

  @Field(() => Float, { nullable: true, description: 'Average length in cm' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  averageLength?: number;

  @Field(() => Float, { nullable: true, description: 'Condition factor (K = 100 * W / L^3)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  conditionFactor?: number;

  // -------------------------------------------------------------------------
  // GROWTH METRICS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Feed Conversion Ratio for the period' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  feedConversionRatio?: number;

  @Field(() => Float, { nullable: true, description: 'Specific Growth Rate (% per day)' })
  @IsOptional()
  @IsNumber()
  @Min(-10)
  @Max(20)
  specificGrowthRate?: number;

  // -------------------------------------------------------------------------
  // CONDITIONS AND CONTEXT
  // -------------------------------------------------------------------------

  @Field(() => MeasurementConditionsInput, {
    nullable: true,
    description: 'Environmental conditions during measurement',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MeasurementConditionsInput)
  conditions?: MeasurementConditionsInput;

  // -------------------------------------------------------------------------
  // USER INFO
  // -------------------------------------------------------------------------

  @Field({ description: 'Measurement date and time' })
  @IsDate()
  @Type(() => Date)
  measuredAt!: Date;

  @Field(() => ID, { description: 'User ID who performed the measurement' })
  @IsUUID()
  measuredBy!: string;

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  // -------------------------------------------------------------------------
  // OPTIONS
  // -------------------------------------------------------------------------

  @Field(() => Boolean, {
    defaultValue: true,
    description: 'Whether to update batch average weight',
  })
  @IsOptional()
  @IsBoolean()
  updateBatchWeight?: boolean;

  // -------------------------------------------------------------------------
  // METADATA
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true, description: 'Additional metadata' })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
