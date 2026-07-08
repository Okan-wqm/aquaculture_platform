/**
 * UpdateGrowthMeasurement Input DTO
 *
 * Input type for updating existing growth measurements.
 * All fields except ID are optional.
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
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  MeasurementType,
  MeasurementMethod,
  GrowthPerformance,
} from '../entities/growth-measurement.entity';
import {
  IndividualMeasurementInput,
  MeasurementConditionsInput,
} from './create-growth-measurement.input';

@InputType()
export class UpdateGrowthMeasurementInput {
  // -------------------------------------------------------------------------
  // IDENTIFIER
  // -------------------------------------------------------------------------

  @Field(() => ID, { description: 'Measurement ID to update' })
  @IsUUID()
  id!: string;

  // -------------------------------------------------------------------------
  // LOCATION (can be updated if fish moved)
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true, description: 'Pond ID' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  // -------------------------------------------------------------------------
  // MEASUREMENT INFO
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Measurement date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  measurementDate?: Date;

  @Field(() => MeasurementType, { nullable: true, description: 'Type of measurement' })
  @IsOptional()
  @IsEnum(MeasurementType)
  measurementType?: MeasurementType;

  @Field(() => MeasurementMethod, { nullable: true, description: 'Method used for measurement' })
  @IsOptional()
  @IsEnum(MeasurementMethod)
  measurementMethod?: MeasurementMethod;

  // -------------------------------------------------------------------------
  // SAMPLE INFO
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true, description: 'Number of fish sampled' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  sampleSize?: number;

  @Field(() => Int, { nullable: true, description: 'Total population size' })
  @IsOptional()
  @IsInt()
  @Min(1)
  populationSize?: number;

  // -------------------------------------------------------------------------
  // INDIVIDUAL MEASUREMENTS
  // -------------------------------------------------------------------------

  @Field(() => [IndividualMeasurementInput], {
    nullable: true,
    description: 'Updated individual measurement data',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndividualMeasurementInput)
  individualMeasurements?: IndividualMeasurementInput[];

  // -------------------------------------------------------------------------
  // METRICS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Average weight in grams' })
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

  @Field(() => Float, { nullable: true, description: 'Condition factor' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  conditionFactor?: number;

  @Field(() => Float, { nullable: true, description: 'Feed Conversion Ratio' })
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
  // PERFORMANCE OVERRIDE
  // -------------------------------------------------------------------------

  @Field(() => GrowthPerformance, { nullable: true, description: 'Manual performance override' })
  @IsOptional()
  @IsEnum(GrowthPerformance)
  performance?: GrowthPerformance;

  // -------------------------------------------------------------------------
  // CONDITIONS
  // -------------------------------------------------------------------------

  @Field(() => MeasurementConditionsInput, {
    nullable: true,
    description: 'Environmental conditions',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MeasurementConditionsInput)
  conditions?: MeasurementConditionsInput;

  // -------------------------------------------------------------------------
  // USER INFO
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Measurement timestamp' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  measuredAt?: Date;

  @Field(() => ID, { nullable: true, description: 'User ID who performed measurement' })
  @IsOptional()
  @IsUUID()
  measuredBy?: string;

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  // -------------------------------------------------------------------------
  // VERIFICATION
  // -------------------------------------------------------------------------

  @Field(() => Boolean, { nullable: true, description: 'Mark as verified' })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @Field(() => ID, { nullable: true, description: 'User ID who verified' })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;

  @Field({ nullable: true, description: 'Verification timestamp' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  verifiedAt?: Date;

  // -------------------------------------------------------------------------
  // OPTIONS
  // -------------------------------------------------------------------------

  @Field(() => Boolean, { nullable: true, description: 'Update batch average weight' })
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
