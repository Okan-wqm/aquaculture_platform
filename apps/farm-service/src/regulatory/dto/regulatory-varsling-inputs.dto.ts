/**
 * Immediate Regulatory Report ("varsling") Input DTOs
 *
 * GraphQL input types for the three LEGALLY-IMMEDIATE Mattilsynet reports:
 *   - Welfare event   (Velferdshendelse)
 *   - Fish escape     (Rømmingsmelding)  → also Fiskeridirektoratet
 *   - Disease outbreak (Sykdomsutbrudd)
 *
 * WHY these are NOT in regulatory-inputs.dto.ts — those DTOs target the
 * Mattilsynet `innrapportering-api` (Maskinporten REST). That API has NO
 * welfare/escape/disease endpoints; the regulation routes these to
 * varsling.akva@mattilsynet.no as urgent notifications. So the input shape
 * here mirrors the EmailService.RegulatoryReportEmailData contract (the real
 * delivery channel), not a REST payload.
 *
 * @module Regulatory/DTO/Varsling
 */
import { InputType, Field, Float, Int, registerEnumType } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================================
// Enums
// ============================================================================

export enum WelfareEventTypeInput {
  MORTALITY_THRESHOLD = 'mortality_threshold',
  EQUIPMENT_FAILURE = 'equipment_failure',
  WELFARE_IMPACT = 'welfare_impact',
}

export enum WelfareSeverityInput {
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum DiseaseCategoryInput {
  A = 'A',
  C = 'C',
  F = 'F',
}

export enum DiseaseConfirmationInput {
  SUSPECTED = 'suspected',
  CONFIRMED = 'confirmed',
}

registerEnumType(WelfareEventTypeInput, { name: 'WelfareEventTypeInput' });
registerEnumType(WelfareSeverityInput, { name: 'WelfareSeverityInput' });
registerEnumType(DiseaseCategoryInput, { name: 'DiseaseCategoryInput' });
registerEnumType(DiseaseConfirmationInput, { name: 'DiseaseConfirmationInput' });

// ============================================================================
// Shared contact + base
// ============================================================================

/**
 * Contact person — required object for every Mattilsynet report.
 * `telefonnummer` is optional for varsling reports (email is the channel).
 */
@InputType()
export class VarslingKontaktpersonInput {
  @Field({ description: 'Contact person name' })
  @IsNotEmpty()
  @IsString()
  navn!: string;

  @Field({ description: 'Contact person email' })
  @IsNotEmpty()
  @IsEmail()
  epost!: string;

  @Field({ nullable: true, description: 'Contact person phone number (e.g., +4798989898)' })
  @IsOptional()
  @IsString()
  telefonnummer?: string;
}

/**
 * Base identity block shared by all three immediate reports.
 */
@InputType()
export class VarslingBaseInput {
  @Field({ description: 'Client reference — unique identifier for the submission (UUID)' })
  @IsNotEmpty()
  @IsString()
  klientReferanse!: string;

  @Field({ description: 'Norwegian organization number (9 digits)' })
  @IsNotEmpty()
  @IsString()
  organisasjonsnummer!: string;

  @Field(() => Int, { description: 'Site/Locality registration number (NUMBER, not string!)' })
  @IsInt()
  lokalitetsnummer!: number;

  @Field({ description: 'Internal site identifier' })
  @IsNotEmpty()
  @IsString()
  siteId!: string;

  @Field({ description: 'Human-readable site name' })
  @IsNotEmpty()
  @IsString()
  siteName!: string;

  @Field({ nullable: true, description: 'Site code (optional)' })
  @IsOptional()
  @IsString()
  siteCode?: string;

  @Field(() => VarslingKontaktpersonInput, { description: 'Contact person (required object)' })
  @ValidateNested()
  @Type(() => VarslingKontaktpersonInput)
  kontaktperson!: VarslingKontaktpersonInput;

  @Field({ nullable: true, description: 'Site-manager CC recipient' })
  @IsOptional()
  @IsEmail()
  siteManagerEmail?: string;

  @Field({ description: 'When the incident was detected (ISO 8601)' })
  @IsNotEmpty()
  @IsString()
  detectedAt!: string;

  @Field({ description: 'Name of the person submitting the report' })
  @IsNotEmpty()
  @IsString()
  reportedBy!: string;
}

// ============================================================================
// Welfare Event
// ============================================================================

@InputType()
export class SubmitWelfareEventInput extends VarslingBaseInput {
  @Field(() => WelfareEventTypeInput, { description: 'Welfare event type' })
  @IsEnum(WelfareEventTypeInput)
  welfareEventType!: WelfareEventTypeInput;

  @Field(() => WelfareSeverityInput, { description: 'Severity' })
  @IsEnum(WelfareSeverityInput)
  severity!: WelfareSeverityInput;

  @Field(() => Float, { nullable: true, description: 'Mortality rate (%) — for mortality_threshold' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mortalityRate?: number;

  @Field({ nullable: true, description: 'Mortality period (e.g., 1_day / 3_day / 7_day)' })
  @IsOptional()
  @IsString()
  mortalityPeriod?: string;

  @Field(() => [String], { nullable: true, description: 'Affected batch numbers' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedBatches?: string[];

  @Field({ description: 'Incident description' })
  @IsNotEmpty()
  @IsString()
  description!: string;

  @Field(() => [String], { description: 'Immediate actions taken (at least one required)' })
  @IsArray()
  @IsString({ each: true })
  immediateActions!: string[];
}

// ============================================================================
// Escape
// ============================================================================

@InputType()
export class SubmitEscapeReportInput extends VarslingBaseInput {
  @Field(() => Int, { description: 'Estimated number of escaped fish' })
  @IsInt()
  @Min(0)
  estimatedCount!: number;

  @Field({ description: 'Species' })
  @IsNotEmpty()
  @IsString()
  species!: string;

  @Field(() => Float, { description: 'Average weight (grams)' })
  @IsNumber()
  @Min(0)
  avgWeightG!: number;

  @Field(() => Float, { description: 'Total escaped biomass (kg)' })
  @IsNumber()
  @Min(0)
  totalBiomassKg!: number;

  @Field({ description: 'Cause of escape' })
  @IsNotEmpty()
  @IsString()
  cause!: string;

  @Field(() => [String], { description: 'Affected units (cage/tank identifiers)' })
  @IsArray()
  @IsString({ each: true })
  affectedUnits!: string[];

  @Field({ description: 'Whether recovery efforts are ongoing' })
  @IsBoolean()
  recoveryOngoing!: boolean;
}

// ============================================================================
// Disease Outbreak
// ============================================================================

@InputType()
export class SubmitDiseaseOutbreakInput extends VarslingBaseInput {
  @Field(() => DiseaseCategoryInput, { description: 'Disease list category (A/C/F)' })
  @IsEnum(DiseaseCategoryInput)
  diseaseCategory!: DiseaseCategoryInput;

  @Field({ description: 'Disease name' })
  @IsNotEmpty()
  @IsString()
  diseaseName!: string;

  @Field(() => DiseaseConfirmationInput, { description: 'Suspected or lab-confirmed' })
  @IsEnum(DiseaseConfirmationInput)
  confirmation!: DiseaseConfirmationInput;

  @Field(() => Int, { description: 'Estimated number of affected fish' })
  @IsInt()
  @Min(0)
  affectedCount!: number;

  @Field(() => Float, { description: 'Affected percentage of population' })
  @IsNumber()
  @Min(0)
  @Max(100)
  affectedPercentage!: number;

  @Field(() => [String], { description: 'Observed clinical signs' })
  @IsArray()
  @IsString({ each: true })
  clinicalSigns!: string[];

  @Field({ description: 'Whether a veterinarian has been notified' })
  @IsBoolean()
  veterinarianNotified!: boolean;

  @Field({ nullable: true, description: 'Veterinarian name' })
  @IsOptional()
  @IsString()
  veterinarianName?: string;
}
