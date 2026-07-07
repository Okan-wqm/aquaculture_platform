/**
 * Create Feeding Protocol Input DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  MaxLength,
  MinLength,
  IsEnum,
  IsArray,
  ValidateNested,
  IsUUID,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FeedType } from '../entities/feed.entity';

/**
 * Feeding Temperature Range Input - for feeding protocol temperature adjustments
 */
@InputType('FeedingTemperatureRangeInput')
export class FeedingTemperatureRangeInput {
  @Field(() => Float)
  @IsNumber()
  min!: number;

  @Field(() => Float)
  @IsNumber()
  max!: number;

  @Field({ defaultValue: 'celsius' })
  @IsOptional()
  @IsString()
  unit?: 'celsius' | 'fahrenheit';

  @Field(() => Float, { description: 'Multiplier applied to normal feeding rate' })
  @IsNumber()
  feedingMultiplier!: number;
}

/**
 * Feeding Protocol Schedule Entry Input
 * NOTE: Renamed from FeedingScheduleEntryInput to avoid GraphQL Federation conflict
 */
@InputType('FeedingProtocolScheduleEntryInput')
export class FeedingProtocolScheduleEntryInput {
  @Field({ description: 'Feeding time (e.g., "08:00", "12:00")' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  time!: string;

  @Field(() => Float, { description: 'Percentage of daily amount' })
  @IsNumber()
  percentOfDaily!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Feeding Schedule Adjustments Input
 */
@InputType()
export class FeedingScheduleAdjustmentsInput {
  @Field(() => Float, { nullable: true, description: 'Reduction percentage for low oxygen' })
  @IsOptional()
  @IsNumber()
  lowOxygenReduction?: number;

  @Field(() => Float, { nullable: true, description: 'Reduction percentage post stress' })
  @IsOptional()
  @IsNumber()
  postStressReduction?: number;

  @Field(() => Float, { nullable: true, description: 'Fasting hours before medication' })
  @IsOptional()
  @IsNumber()
  preMedicationFasting?: number;
}

/**
 * Feeding Schedule Input
 */
@InputType()
export class FeedingScheduleInput {
  @Field(() => Int)
  @IsNumber()
  totalMealsPerDay!: number;

  @Field(() => [FeedingProtocolScheduleEntryInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedingProtocolScheduleEntryInput)
  schedule!: FeedingProtocolScheduleEntryInput[];

  @Field(() => FeedingScheduleAdjustmentsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingScheduleAdjustmentsInput)
  adjustments?: FeedingScheduleAdjustmentsInput;
}

/**
 * Growth Stage Protocol Input
 */
@InputType()
export class GrowthStageProtocolInput {
  @Field(() => Float)
  @IsNumber()
  minWeight!: number;

  @Field(() => Float)
  @IsNumber()
  maxWeight!: number;

  @Field({ defaultValue: 'gram' })
  @IsOptional()
  @IsString()
  weightUnit?: 'gram' | 'kg';

  @Field(() => Float, { description: 'Feed percentage of body weight' })
  @IsNumber()
  feedPercent!: number;

  @Field(() => FeedingScheduleInput)
  @ValidateNested()
  @Type(() => FeedingScheduleInput)
  schedule!: FeedingScheduleInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Optimal Temperature Input
 */
@InputType()
export class OptimalTemperatureInput {
  @Field(() => Float)
  @IsNumber()
  min!: number;

  @Field(() => Float)
  @IsNumber()
  max!: number;

  @Field({ defaultValue: 'celsius' })
  @IsOptional()
  @IsString()
  unit?: 'celsius' | 'fahrenheit';
}

/**
 * Special Conditions Input
 */
@InputType()
export class SpecialConditionsInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  spawningPeriod?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  winterFeeding?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  diseaseOutbreak?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  waterQualityIssues?: string;
}

/**
 * Create Feeding Protocol Input
 */
@InputType()
export class CreateFeedingProtocolInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  species!: string;

  @Field(() => FeedType, { defaultValue: FeedType.GROWER })
  @IsOptional()
  @IsEnum(FeedType)
  stage?: FeedType;

  @Field(() => [FeedingTemperatureRangeInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeedingTemperatureRangeInput)
  temperatureRanges?: FeedingTemperatureRangeInput[];

  @Field(() => [GrowthStageProtocolInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrowthStageProtocolInput)
  growthStageProtocols?: GrowthStageProtocolInput[];

  @Field(() => FeedingScheduleInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingScheduleInput)
  defaultSchedule?: FeedingScheduleInput;

  @Field(() => Float, { nullable: true, description: 'Target Feed Conversion Ratio' })
  @IsOptional()
  @IsNumber()
  targetFcr?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum dissolved oxygen level (mg/L)' })
  @IsOptional()
  @IsNumber()
  minDissolvedOxygen?: number;

  @Field(() => OptimalTemperatureInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OptimalTemperatureInput)
  optimalTemperature?: OptimalTemperatureInput;

  @Field(() => SpecialConditionsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SpecialConditionsInput)
  specialConditions?: SpecialConditionsInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
