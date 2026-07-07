/**
 * Update FeedingProgram DTO
 * @module Feeding/DTO
 */
import { InputType, Field, Float, Int, ID, PartialType, OmitType } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsDateString,
  IsArray,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FeedingProgramStatus } from '../entities/feeding-program.entity';
import {
  CreateFeedingProgramInput,
  FeedAssignmentInput,
  FCRTableInput,
  ProgramSettingsInput,
} from './create-feeding-program.input';

// ============================================================================
// PARTIAL UPDATE INPUT
// ============================================================================

/**
 * Update feeding program input - tum alanlar opsiyonel
 * tankIds update'te kullanilmaz - ayri mutation ile yonetilir
 */
@InputType()
export class UpdateFeedingProgramInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  id?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Field(() => [FeedAssignmentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FeedAssignmentInput)
  feedAssignments?: FeedAssignmentInput[];

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

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

// ============================================================================
// STATUS UPDATE INPUT
// ============================================================================

/**
 * Program durum guncelleme input
 */
@InputType()
export class UpdateFeedingProgramStatusInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field(() => FeedingProgramStatus)
  @IsNotEmpty()
  @IsEnum(FeedingProgramStatus)
  status!: FeedingProgramStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ============================================================================
// ACTIVATE / PAUSE / COMPLETE INPUTS
// ============================================================================

/**
 * Program aktive etme input
 */
@InputType()
export class ActivateFeedingProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

/**
 * Program duraklat input
 */
@InputType()
export class PauseFeedingProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  resumeDate?: string;
}

/**
 * Program tamamla input
 */
@InputType()
export class CompleteFeedingProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  completionNotes?: string;
}

/**
 * Program iptal etme input
 */
@InputType()
export class CancelFeedingProgramInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  cancellationReason!: string;
}
