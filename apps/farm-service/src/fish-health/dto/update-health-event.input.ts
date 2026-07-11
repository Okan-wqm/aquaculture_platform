/**
 * UpdateHealthEvent Input DTO
 *
 * DTO for updating existing health events.
 * All fields are optional except the ID.
 *
 * @module FishHealth
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsUUID,
  IsDate,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsArray,
  MaxLength,
  MinLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  HealthEventType,
  HealthSeverity,
  HealthEventStatus,
  DiseaseCategory,
} from '../entities/health-event.entity';
import {
  ObservedSymptomsInput,
  TreatmentDetailsInput,
  AffectedPopulationInput,
  LabResultsInput,
  VetConsultationInput,
  WaterQualitySnapshotInput,
} from './create-health-event.input';

@InputType()
export class UpdateHealthEventInput {
  @Field(() => ID, { description: 'Health Event ID' })
  @IsUUID()
  id!: string;

  // -------------------------------------------------------------------------
  // LOCATION REFERENCES
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
  // EVENT INFORMATION
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Event title' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @Field({ nullable: true, description: 'Detailed description' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => HealthEventType, { nullable: true, description: 'Type of health event' })
  @IsOptional()
  @IsEnum(HealthEventType)
  eventType?: HealthEventType;

  @Field({ nullable: true, description: 'Event date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  eventDate?: Date;

  @Field({ nullable: true, description: 'Event time (e.g., "08:30")' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  eventTime?: string;

  // -------------------------------------------------------------------------
  // DISEASE INFORMATION
  // -------------------------------------------------------------------------

  @Field(() => DiseaseCategory, { nullable: true, description: 'Disease category' })
  @IsOptional()
  @IsEnum(DiseaseCategory)
  diseaseCategory?: DiseaseCategory;

  @Field({ nullable: true, description: 'Disease name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  diseaseName?: string;

  @Field(() => HealthSeverity, { nullable: true, description: 'Severity level' })
  @IsOptional()
  @IsEnum(HealthSeverity)
  severity?: HealthSeverity;

  // -------------------------------------------------------------------------
  // SYMPTOMS
  // -------------------------------------------------------------------------

  @Field(() => ObservedSymptomsInput, { nullable: true, description: 'Observed symptoms' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ObservedSymptomsInput)
  symptomsObserved?: ObservedSymptomsInput;

  @Field({ nullable: true, description: 'Diagnosis summary' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  diagnosis?: string;

  // -------------------------------------------------------------------------
  // AFFECTED POPULATION
  // -------------------------------------------------------------------------

  @Field(() => AffectedPopulationInput, { nullable: true, description: 'Affected population details' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AffectedPopulationInput)
  affectedPopulation?: AffectedPopulationInput;

  @Field(() => Int, { nullable: true, description: 'Number of affected fish' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  affectedCount?: number;

  @Field(() => Int, { nullable: true, description: 'Mortality count' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mortalityCount?: number;

  // -------------------------------------------------------------------------
  // TREATMENT
  // -------------------------------------------------------------------------

  @Field(() => TreatmentDetailsInput, { nullable: true, description: 'Treatment details' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TreatmentDetailsInput)
  treatment?: TreatmentDetailsInput;

  @Field({ nullable: true, description: 'Medication name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  medication?: string;

  @Field({ nullable: true, description: 'Is currently under treatment' })
  @IsOptional()
  @IsBoolean()
  isUnderTreatment?: boolean;

  @Field({ nullable: true, description: 'Expected treatment end date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  treatmentEndDate?: Date;

  @Field(() => Int, { nullable: true, description: 'Withdrawal period in days before harvest' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  withdrawalPeriodDays?: number;

  @Field({ nullable: true, description: 'Earliest harvest date (calculated from withdrawal period)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  earliestHarvestDate?: Date;

  // -------------------------------------------------------------------------
  // QUARANTINE
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Is quarantined' })
  @IsOptional()
  @IsBoolean()
  isQuarantined?: boolean;

  @Field({ nullable: true, description: 'Quarantine start date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  quarantineStartDate?: Date;

  @Field({ nullable: true, description: 'Quarantine end date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  quarantineEndDate?: Date;

  @Field(() => ID, { nullable: true, description: 'Quarantine tank ID' })
  @IsOptional()
  @IsUUID()
  quarantineTankId?: string;

  // -------------------------------------------------------------------------
  // LABORATORY
  // -------------------------------------------------------------------------

  @Field(() => LabResultsInput, { nullable: true, description: 'Laboratory results' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LabResultsInput)
  labResults?: LabResultsInput;

  @Field({ nullable: true, description: 'Lab confirmed diagnosis' })
  @IsOptional()
  @IsBoolean()
  labConfirmed?: boolean;

  // -------------------------------------------------------------------------
  // VETERINARY
  // -------------------------------------------------------------------------

  @Field(() => VetConsultationInput, { nullable: true, description: 'Veterinary consultation details' })
  @IsOptional()
  @ValidateNested()
  @Type(() => VetConsultationInput)
  vetConsultation?: VetConsultationInput;

  @Field({ nullable: true, description: 'Vet has been notified' })
  @IsOptional()
  @IsBoolean()
  vetNotified?: boolean;

  // -------------------------------------------------------------------------
  // WATER QUALITY
  // -------------------------------------------------------------------------

  @Field(() => WaterQualitySnapshotInput, { nullable: true, description: 'Water quality at time of observation' })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterQualitySnapshotInput)
  waterQualitySnapshot?: WaterQualitySnapshotInput;

  @Field(() => ID, { nullable: true, description: 'Related water quality measurement ID' })
  @IsOptional()
  @IsUUID()
  relatedWaterQualityMeasurementId?: string;

  // -------------------------------------------------------------------------
  // STATUS
  // -------------------------------------------------------------------------

  @Field(() => HealthEventStatus, { nullable: true, description: 'Event status' })
  @IsOptional()
  @IsEnum(HealthEventStatus)
  status?: HealthEventStatus;

  @Field({ nullable: true, description: 'Resolution date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  resolvedDate?: Date;

  @Field({ nullable: true, description: 'Resolution notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNotes?: string;

  // -------------------------------------------------------------------------
  // RELATED EVENTS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Parent event ID' })
  @IsOptional()
  @IsUUID()
  parentEventId?: string;

  @Field(() => ID, { nullable: true, description: 'Related alert incident ID' })
  @IsOptional()
  @IsUUID()
  alertIncidentId?: string;

  // -------------------------------------------------------------------------
  // COST
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Estimated cost' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedCost?: number;

  @Field({ nullable: true, description: 'Currency code' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  // -------------------------------------------------------------------------
  // USER INFORMATION
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @Field(() => [String], { nullable: true, description: 'Attachment URLs (photos, videos)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  // -------------------------------------------------------------------------
  // FOLLOW-UP
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Follow-up required' })
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @Field({ nullable: true, description: 'Next follow-up date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  followUpDate?: Date;
}
