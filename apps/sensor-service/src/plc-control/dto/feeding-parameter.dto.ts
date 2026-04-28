import { InputType, Field, ID, Int, Float, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsUUID,
  IsNumber,
  IsArray,
  Min,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

import { FeedingParameter, ParameterStatus } from '../entities/feeding-parameter.entity';

/**
 * PLC Feeding schedule entry input
 * NOTE: Renamed from FeedingScheduleEntryInput to avoid GraphQL Federation conflict with farm-service
 */
@InputType('PlcFeedingScheduleEntryInput')
export class PlcFeedingScheduleEntryInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  time!: string; // HH:mm format

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feedType?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(10000)
  amountKg!: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(3600)
  durationSeconds?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  blowerSpeedPercent?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  doserSpeedPercent?: number;
}

/**
 * Threshold configuration input
 */
@InputType('ThresholdConfigInput')
export class ThresholdConfigInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(20)
  oxygenMin!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(20)
  oxygenCritical!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(50)
  tempMax!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(50)
  tempCritical!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14)
  phMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14)
  phMax?: number;
}

/**
 * VFD settings input
 */
@InputType('VfdSettingsInput')
export class VfdSettingsInput {
  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(100)
  blowerMinSpeed!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(100)
  blowerMaxSpeed!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(100)
  doserMinSpeed!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  @Max(100)
  doserMaxSpeed!: number;
}

/**
 * Input DTO for creating feeding parameters
 */
@InputType('CreateFeedingParameterInput')
export class CreateFeedingParameterDto {
  @Field(() => ID)
  @IsUUID()
  plcConnectionId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field({ nullable: true, defaultValue: '1.0' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(1000000)
  biomassKg!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.1)
  @Max(10)
  fcr!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100000)
  targetDailyFeedKg!: number;

  @Field(() => [PlcFeedingScheduleEntryInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlcFeedingScheduleEntryInput)
  schedule!: PlcFeedingScheduleEntryInput[];

  @Field(() => ThresholdConfigInput)
  @ValidateNested()
  @Type(() => ThresholdConfigInput)
  thresholds!: ThresholdConfigInput;

  @Field(() => VfdSettingsInput)
  @ValidateNested()
  @Type(() => VfdSettingsInput)
  vfdSettings!: VfdSettingsInput;
}

/**
 * Input DTO for updating feeding parameters
 */
@InputType('UpdateFeedingParameterInput')
export class UpdateFeedingParameterDto {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  biomassKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  fcr?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  targetDailyFeedKg?: number;

  @Field(() => [PlcFeedingScheduleEntryInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlcFeedingScheduleEntryInput)
  schedule?: PlcFeedingScheduleEntryInput[];

  @Field(() => ThresholdConfigInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThresholdConfigInput)
  thresholds?: ThresholdConfigInput;

  @Field(() => VfdSettingsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => VfdSettingsInput)
  vfdSettings?: VfdSettingsInput;
}

/**
 * Filter input for querying feeding parameters
 */
@InputType('FeedingParameterFilterInput')
export class FeedingParameterFilterDto {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  plcConnectionId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEnum(ParameterStatus)
  status?: ParameterStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

/**
 * Paginated feeding parameters response
 */
@ObjectType('PaginatedFeedingParameters')
export class PaginatedFeedingParametersDto extends StandardPaginatedResponse(FeedingParameter) {}

/**
 * Parameter send result
 */
@ObjectType('ParameterSendResult')
export class ParameterSendResultDto {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  checksum?: string;

  @Field({ nullable: true })
  error?: string;

  @Field()
  sentAt!: Date;
}
