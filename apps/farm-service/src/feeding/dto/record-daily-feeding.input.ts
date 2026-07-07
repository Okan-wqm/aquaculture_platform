/**
 * Record Daily Feeding DTO
 * @module Feeding/DTO
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { FeedingMethod } from '../entities/feeding-record.entity';

// ============================================================================
// SINGLE RECORD INPUT
// ============================================================================

/**
 * Gunluk yemleme kaydi input
 */
@InputType()
export class RecordDailyFeedingInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  actualKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @Field(() => ID, { nullable: true, description: 'SubEquipment feeder ID (for automatic feeders)' })
  @IsOptional()
  @IsUUID()
  feederEquipmentId?: string;

  @Field(() => FeedingMethod, { nullable: true, description: 'Feeding method used' })
  @IsOptional()
  @IsEnum(FeedingMethod)
  feedingMethod?: FeedingMethod;
}

/**
 * Gunluk yemleme atlama input
 */
@InputType()
export class SkipDailyFeedingInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  skipReason!: string;
}

// ============================================================================
// BULK RECORD INPUT
// ============================================================================

/**
 * Tek yemleme kaydi (bulk icinde kullanilir)
 */
@InputType()
export class FeedingRecordItemInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  actualKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Toplu yemleme kaydi input
 */
@InputType()
export class RecordBulkDailyFeedingInput {
  @Field(() => [FeedingRecordItemInput])
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FeedingRecordItemInput)
  records!: FeedingRecordItemInput[];
}

// ============================================================================
// WITH MORTALITY INPUT
// ============================================================================

/**
 * Mortalite bilgisi input
 */
@InputType()
export class MortalityInfoInput {
  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  count!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedBiomassKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cause?: string;
}

/**
 * Yemleme kaydi + mortalite input
 */
@InputType()
export class RecordDailyFeedingWithMortalityInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  actualKg!: number;

  @Field(() => MortalityInfoInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => MortalityInfoInput)
  mortality?: MortalityInfoInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ============================================================================
// UPDATE RECORD INPUT
// ============================================================================

/**
 * Yemleme kaydi guncelleme input (tamamlanmis kayit icin)
 */
@InputType()
export class UpdateDailyFeedingRecordInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualKg?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  correctionReason?: string;
}

// ============================================================================
// FCR OVERRIDE INPUT
// ============================================================================

/**
 * FCR override ile yemleme kaydi input
 */
@InputType()
export class RecordDailyFeedingWithFCRInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  executionId!: string;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  actualKg!: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.5)
  @Max(5)
  overrideFCR!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  fcrOverrideReason?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ============================================================================
// FORCE FEED TRANSITION INPUT
// ============================================================================

/**
 * Manuel yem gecisi zorlama input
 */
@InputType()
export class ForceFeedTransitionInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  feedingProgramTankId!: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  newFeedId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  transitionReason?: string;
}

// ============================================================================
// GENERATE DAILY PLAN INPUT
// ============================================================================

/**
 * Gunluk yemleme plani olusturma input
 * Frontend bu input'u tek nesne olarak gonderir
 */
@InputType()
export class GenerateDailyPlanInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  programId!: string;

  @Field()
  @IsNotEmpty()
  date!: Date;
}
