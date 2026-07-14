/**
 * Field-capture inputs for the regulatory operational entities: lice counts,
 * treatment applications, welfare assessments and escape incidents.
 *
 * Phase 6 (FARM-HIGH-214): the three field-recordable inputs extend
 * MobileCommandEnvelopeInput so AquaMobil's offline queue can stamp its
 * at-most-once command envelope (clientCommandId + payloadHash + deviceId)
 * onto the SAME wire input desktop uses. The envelope stays nullable —
 * desktop callers omit it (legacy mode) — and each service decides the
 * idempotency mechanism: lice counts are naturally idempotent (upsert on
 * (tenant, tank, countDate)); welfare + escape are plain inserts and run
 * through the farm_mobile_command_receipts ledger.
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { EscapeIncidentCause } from '../entities/escape-incident.entity';
import { TreatmentCategory } from '../entities/treatment-application.entity';

@InputType()
export class RecordLiceCountInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID)
  @IsUUID()
  tankId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field({ description: 'Counting date (yyyy-mm-dd)' })
  @IsDateString()
  countDate!: string;

  @Field(() => Float, { description: 'Adult female lice (voksne hunnlus), avg per fish' })
  @IsNumber()
  @Min(0)
  adultFemaleLice!: number;

  @Field(() => Float, { description: 'Mobile lice (bevegelige lus), avg per fish' })
  @IsNumber()
  @Min(0)
  mobileLice!: number;

  @Field(() => Float, { description: 'Attached lice (fastsittende lus), avg per fish' })
  @IsNumber()
  @Min(0)
  attachedLice!: number;

  @Field(() => Int, { description: 'Fish sampled (regulation: 10 or 20 per pen)' })
  @IsInt()
  @Min(1)
  fishSampled!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  seaTemperatureC?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  mediaKeys?: string[];
}

@InputType()
export class RecordTreatmentApplicationInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  healthEventId?: string;

  @Field(() => TreatmentCategory)
  @IsEnum(TreatmentCategory)
  category!: TreatmentCategory;

  @Field({ description: 'Official Mattilsynet method value (e.g. BADEBEHANDLING)' })
  @IsString()
  @MaxLength(40)
  method!: string;

  @Field(() => ID, { nullable: true, description: 'Chemicals-catalog reference (medicinal)' })
  @IsOptional()
  @IsUUID()
  chemicalId?: string;

  @Field({ nullable: true, description: 'Official virkestoff enum value' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  virkestoffType?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  styrkeVerdi?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  styrkeEnhet?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mengdeVerdi?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  mengdeEnhet?: string;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  wholeSite?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  pensCount?: number;

  @Field({ description: 'When the treatment was applied (ISO timestamp)' })
  @IsDateString()
  appliedAt!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  veterinarianWorkerId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalVetName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  beskrivelse?: string;
}

@InputType()
export class RecordWelfareAssessmentInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID)
  @IsUUID()
  tankId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field({ description: 'Assessment date (yyyy-mm-dd)' })
  @IsDateString()
  assessedAt!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  fishSampled!: number;

  @Field(() => Int, { description: '0 (healthy) .. 3 (severe)' })
  @IsInt()
  @Min(0)
  @Max(3)
  gillScore!: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(3)
  finScore!: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(3)
  woundScore!: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(3)
  deformityScore!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  mediaKeys?: string[];
}

@InputType()
export class RecordEscapeIncidentInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field({ description: 'When the escape was detected (ISO timestamp)' })
  @IsDateString()
  detectedAt!: string;

  @Field(() => ID)
  @IsUUID()
  speciesId!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  estimatedCount!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  avgWeightG?: number;

  @Field(() => EscapeIncidentCause, { defaultValue: EscapeIncidentCause.UNKNOWN })
  @IsOptional()
  @IsEnum(EscapeIncidentCause)
  cause?: EscapeIncidentCause;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  causeDetails?: string;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  recoveryOngoing?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  mediaKeys?: string[];
}

@InputType()
export class CloseEscapeIncidentInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => Int, { nullable: true, description: 'Final recaptured count' })
  @IsOptional()
  @IsInt()
  @Min(0)
  recoveredCount?: number;
}
