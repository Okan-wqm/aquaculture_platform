/**
 * Create FeedingProgram DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FCRSource, GrowthApplicationMode } from '../entities/feeding-program.entity';
import { ProgramEquipmentType } from '../entities/feeding-program-tank.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

/**
 * Tank assignment input - programa tank eklemek icin
 */
@InputType()
export class TankAssignmentInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  equipmentId: string;

  @Field(() => ProgramEquipmentType, { defaultValue: ProgramEquipmentType.TANK })
  @IsOptional()
  @IsEnum(ProgramEquipmentType)
  equipmentType?: ProgramEquipmentType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Feed assignment input - agirlik araligina gore yem atamasi
 */
@InputType()
export class FeedAssignmentInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedId: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  minWeightG: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  maxWeightG: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  priority?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * FCR table input - Sicaklik x Agirlik matrisi
 */
@InputType()
export class FCRTableInput {
  @Field(() => [Float])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(2)
  temperatures: number[];

  @Field(() => [Float])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(2)
  weights: number[];

  @Field(() => [[Float]])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(2)
  fcrValues: number[][];

  @Field({ nullable: true, defaultValue: 'celsius' })
  @IsOptional()
  @IsString()
  temperatureUnit?: 'celsius' | 'fahrenheit';

  @Field({ nullable: true, defaultValue: 'gram' })
  @IsOptional()
  @IsString()
  weightUnit?: 'gram' | 'kg';

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Program settings input
 */
@InputType()
export class ProgramSettingsInput {
  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  autoTransition?: boolean;

  @Field(() => Float, { defaultValue: 0.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  transitionBuffer?: number;

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  notifyOnTransition?: boolean;

  @Field(() => FCRSource, { defaultValue: FCRSource.FEED })
  @IsOptional()
  @IsEnum(FCRSource)
  fcrSource?: FCRSource;

  @Field(() => GrowthApplicationMode, { defaultValue: GrowthApplicationMode.PER_FEEDING })
  @IsOptional()
  @IsEnum(GrowthApplicationMode)
  growthApplicationMode?: GrowthApplicationMode;

  @Field(() => Int, { nullable: true, defaultValue: 4 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  defaultMealsPerDay?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minFeedingRatePercent?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxFeedingRatePercent?: number;
}

// ============================================================================
// MAIN INPUT
// ============================================================================

/**
 * Create feeding program input
 */
@InputType()
export class CreateFeedingProgramInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  code: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Field(() => [TankAssignmentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TankAssignmentInput)
  tankIds?: TankAssignmentInput[];

  @Field(() => [FeedAssignmentInput])
  @IsNotEmpty()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FeedAssignmentInput)
  feedAssignments: FeedAssignmentInput[];

  @Field(() => FCRTableInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FCRTableInput)
  fcrTable?: FCRTableInput;

  @Field(() => ProgramSettingsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProgramSettingsInput)
  settings?: ProgramSettingsInput;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  startDate: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
