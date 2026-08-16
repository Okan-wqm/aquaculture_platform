import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Field, Float, ID, InputType, Int, registerEnumType } from '@nestjs/graphql';
import {
  FEEDING_DISSOLVED_OXYGEN_RANGE,
  FEEDING_FISH_APPETITE,
  FEEDING_INTENSITY_RANGE,
  FEEDING_SCHOOLING_BEHAVIOR,
  FEEDING_SURFACE_ACTIVITY,
  FEEDING_VISIBILITY,
  FEEDING_WATER_TEMPERATURE_RANGE,
  FEEDING_WEATHER,
  FEEDING_WIND_LEVEL,
  type FeedingFishAppetite,
  type FeedingRecordEnvironment,
  type FeedingRecordFishBehavior,
  type FeedingSchoolingBehavior,
  type FeedingSurfaceActivity,
  type FeedingVisibility,
  type FeedingWeather,
  type FeedingWindLevel,
} from '@aquaculture/feeding-contracts';

import {
  FeedingMethod,
  type FeedingMethod as FeedingMethodValue,
} from '../entities/feeding-record.entity';

registerEnumType(FEEDING_WEATHER, { name: 'FeedingWeather' });
registerEnumType(FEEDING_WIND_LEVEL, { name: 'FeedingWindLevel' });
registerEnumType(FEEDING_VISIBILITY, { name: 'FeedingVisibility' });
registerEnumType(FEEDING_SURFACE_ACTIVITY, { name: 'FeedingSurfaceActivity' });
registerEnumType(FEEDING_SCHOOLING_BEHAVIOR, { name: 'FeedingSchoolingBehavior' });

/** GraphQL projection of the shared closed environment vocabulary. */
@InputType()
export class FeedingEnvironmentInput implements FeedingRecordEnvironment {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(FEEDING_WATER_TEMPERATURE_RANGE.minimum)
  @Max(FEEDING_WATER_TEMPERATURE_RANGE.maximum)
  waterTemp?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(FEEDING_DISSOLVED_OXYGEN_RANGE.minimum)
  @Max(FEEDING_DISSOLVED_OXYGEN_RANGE.maximum)
  dissolvedOxygen?: number;

  @Field(() => FEEDING_WEATHER, { nullable: true })
  @IsOptional()
  @IsEnum(FEEDING_WEATHER)
  weather?: FeedingWeather;

  @Field(() => FEEDING_WIND_LEVEL, { nullable: true })
  @IsOptional()
  @IsEnum(FEEDING_WIND_LEVEL)
  windLevel?: FeedingWindLevel;

  @Field(() => FEEDING_VISIBILITY, { nullable: true })
  @IsOptional()
  @IsEnum(FEEDING_VISIBILITY)
  visibility?: FeedingVisibility;
}

/** GraphQL projection of the shared closed fish-behaviour vocabulary. */
@InputType()
export class FishBehaviorInput implements FeedingRecordFishBehavior {
  @Field(() => FEEDING_FISH_APPETITE)
  @IsEnum(FEEDING_FISH_APPETITE)
  appetite!: FeedingFishAppetite;

  @Field(() => Int)
  @IsInt()
  @Min(FEEDING_INTENSITY_RANGE.minimum)
  @Max(FEEDING_INTENSITY_RANGE.maximum)
  feedingIntensity!: number;

  @Field(() => FEEDING_SURFACE_ACTIVITY, { nullable: true })
  @IsOptional()
  @IsEnum(FEEDING_SURFACE_ACTIVITY)
  surfaceActivity?: FeedingSurfaceActivity;

  @Field(() => FEEDING_SCHOOLING_BEHAVIOR, { nullable: true })
  @IsOptional()
  @IsEnum(FEEDING_SCHOOLING_BEHAVIOR)
  schoolingBehavior?: FeedingSchoolingBehavior;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  abnormalBehavior?: string;
}

@InputType()
export class CreateFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  operationRequestId!: string;

  @Field(() => ID)
  @IsUUID()
  batchId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field()
  @IsDate()
  feedingDate!: Date;

  @Field()
  @IsString()
  @MaxLength(10)
  feedingTime!: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  feedingSequence?: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  totalMealsToday?: number;

  @Field(() => ID)
  @IsUUID()
  feedId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feedBatchNumber?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  plannedAmount!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  actualAmount!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingEnvironmentInput)
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FishBehaviorInput)
  fishBehavior?: FishBehaviorInput;

  @Field(() => FeedingMethod, { defaultValue: FeedingMethod.MANUAL })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod?: FeedingMethodValue;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  feedingDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  feedCost?: number;

  @Field({ nullable: true, defaultValue: 'TRY' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => ID)
  @IsUUID()
  fedBy!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  skipReason?: string;
}
