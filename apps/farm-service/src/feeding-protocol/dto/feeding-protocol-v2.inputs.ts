/**
 * FeedingProtocolV2 GraphQL input tipleri.
 *
 * class-validator sınırları NFR bölümündeki girdi tablosunun birebir kodudur
 * (bands 1-50, oran 0-15%, FCR 0.5-5, çarpan 0.1-2, mealsPerDay 1-24, saat
 * HH:mm, offset ±720dk, rateAdj ±50, eşik 1-100). Geometri/toplam kuralları
 * (boşluk/örtüşme, %toplam=100) alan-bazlı doğrulanamaz — onlar
 * ProtocolValidationService'te (tek doğrulama SSoT'si) koşar.
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  FeedingProtocolStatus,
  MAX_MEALS_PER_DAY,
  MAX_PROTOCOL_BANDS,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import { FeedingUnitType } from '../entities/protocol-assignment.entity';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

@InputType()
export class MealScheduleEntryInput {
  @Field()
  @Matches(TIME_PATTERN, { message: 'time HH:mm formatında olmalı' })
  time!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  percentOfDaily!: number;
}

@InputType()
export class MealScheduleInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(MAX_MEALS_PER_DAY)
  mealsPerDay!: number;

  @Field(() => [MealScheduleEntryInput])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MEALS_PER_DAY)
  @ValidateNested({ each: true })
  @Type(() => MealScheduleEntryInput)
  entries!: MealScheduleEntryInput[];
}

@InputType()
export class ProtocolBandInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100000)
  minWeightG!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100000)
  maxWeightG!: number;

  @Field(() => ID)
  @IsUUID()
  feedId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(15)
  feedingRatePercent!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.5)
  @Max(5)
  expectedFcr!: number;

  @Field(() => MealScheduleInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MealScheduleInput)
  mealSchedule?: MealScheduleInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class TemperatureAdjustmentInput {
  @Field(() => Float)
  @IsNumber()
  @Min(-10)
  @Max(50)
  minC!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-10)
  @Max(50)
  maxC!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.1)
  @Max(2)
  rateMultiplier!: number;
}

@InputType()
export class FcrMatrixInput {
  @Field(() => [Float])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  temperatures!: number[];

  @Field(() => [Float])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  weights!: number[];

  @Field(() => [[Float]])
  @IsArray()
  fcrValues!: number[][];
}

@InputType()
export class ProtocolSettingsInput {
  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  autoTransition!: boolean;

  @Field(() => Float, { defaultValue: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  transitionBufferG!: number;

  @Field({ defaultValue: 'per_meal' })
  @IsOptional()
  @IsIn(['per_meal', 'daily'])
  growthApplicationMode!: 'per_meal' | 'daily';

  @Field(() => Float, { defaultValue: 15 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  underfeedAlertThresholdPercent!: number;

  @Field(() => ProtocolFcrSource, { defaultValue: ProtocolFcrSource.BAND })
  @IsOptional()
  @IsEnum(ProtocolFcrSource)
  fcrSource!: ProtocolFcrSource;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  minDissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(15)
  minFeedingRatePercent?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(15)
  maxFeedingRatePercent?: number;
}

@InputType()
export class CreateFeedingProtocolV2Input {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  speciesId?: string;

  @Field(() => [ProtocolBandInput])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROTOCOL_BANDS)
  @ValidateNested({ each: true })
  @Type(() => ProtocolBandInput)
  bands!: ProtocolBandInput[];

  @Field(() => [TemperatureAdjustmentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TemperatureAdjustmentInput)
  temperatureAdjustments?: TemperatureAdjustmentInput[];

  @Field(() => MealScheduleInput)
  @ValidateNested()
  @Type(() => MealScheduleInput)
  defaultMealSchedule!: MealScheduleInput;

  @Field(() => FcrMatrixInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FcrMatrixInput)
  fcrMatrix?: FcrMatrixInput;

  @Field(() => ProtocolSettingsInput)
  @ValidateNested()
  @Type(() => ProtocolSettingsInput)
  settings!: ProtocolSettingsInput;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isDefault!: boolean;

  @Field(() => FeedingProtocolStatus, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingProtocolStatus)
  status?: FeedingProtocolStatus;
}

@InputType()
export class UpdateFeedingProtocolV2Input extends CreateFeedingProtocolV2Input {
  @Field(() => ID)
  @IsUUID()
  id!: string;
}

@InputType()
export class FcrOverrideInput {
  @Field(() => ID)
  @IsUUID()
  feedId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.5)
  @Max(5)
  expectedFcr!: number;
}

@InputType()
export class AssignmentOverridesInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(-720)
  @Max(720)
  mealTimeOffsetMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MEALS_PER_DAY)
  mealsPerDayOverride?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(-50)
  @Max(50)
  rateAdjustmentPercent?: number;

  @Field(() => [FcrOverrideInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PROTOCOL_BANDS)
  @ValidateNested({ each: true })
  @Type(() => FcrOverrideInput)
  fcrOverrides?: FcrOverrideInput[];
}

@InputType()
export class AssignmentSuspensionInput {
  @Field()
  @IsDate()
  @Type(() => Date)
  from!: Date;

  @Field()
  @IsDate()
  @Type(() => Date)
  to!: Date;

  @Field()
  @IsIn(['fasting', 'medication'])
  type!: 'fasting' | 'medication';

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  reason!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  medicatedFeedId?: string;
}

@InputType()
export class AssignProtocolToUnitInput {
  @Field(() => ID)
  @IsUUID()
  unitId!: string;

  @Field(() => FeedingUnitType)
  @IsEnum(FeedingUnitType)
  unitType!: FeedingUnitType;

  @Field(() => ID)
  @IsUUID()
  protocolId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  effectiveFrom?: Date;

  @Field(() => AssignmentOverridesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssignmentOverridesInput)
  overrides?: AssignmentOverridesInput;

  /** Tür uyumsuzluğunda bilinçli devam (gerekçe zorunlu — audit'e yazılır). */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  speciesMismatchReason?: string;
}

@InputType()
export class UpdateProtocolAssignmentInput {
  @Field(() => ID)
  @IsUUID()
  assignmentId!: string;

  @Field(() => AssignmentOverridesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssignmentOverridesInput)
  overrides?: AssignmentOverridesInput;

  @Field(() => [AssignmentSuspensionInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AssignmentSuspensionInput)
  suspensions?: AssignmentSuspensionInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';
}
