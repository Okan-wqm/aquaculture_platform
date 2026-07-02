/**
 * CreateHealthEvent Input DTO
 *
 * DTO for creating new health events in the fish health module.
 * Includes all fields for disease tracking, treatment, and monitoring.
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
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-type-json';
import {
  HealthEventType,
  HealthSeverity,
  HealthEventStatus,
  DiseaseCategory,
  TreatmentMethod,
} from '../entities/health-event.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

/**
 * Input for observed symptoms
 */
@InputType()
export class ObservedSymptomsInput {
  @Field(() => [String], { nullable: true, description: 'Behavioral symptoms (swimming disorder, loss of appetite)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  behavioral?: string[];

  @Field(() => [String], { nullable: true, description: 'Physical symptoms (lesion, color change)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  physical?: string[];

  @Field(() => [String], { nullable: true, description: 'Respiratory symptoms (rapid gill movement)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  respiratory?: string[];

  @Field(() => [String], { nullable: true, description: 'Other symptoms' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];
}

/**
 * Input for medication details
 */
@InputType()
export class MedicationInput {
  @Field({ description: 'Medication name' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name: string;

  @Field({ description: 'Active ingredient' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  activeIngredient: string;

  @Field(() => Float, { description: 'Dosage (mg/kg or mg/L)' })
  @IsNumber()
  @Min(0)
  dosage: number;

  @Field({ description: 'Dosage unit' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  dosageUnit: string;

  @Field(() => Float, { nullable: true, description: 'Concentration' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  concentration?: number;

  @Field({ nullable: true, description: 'Manufacturer' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  manufacturer?: string;

  @Field({ nullable: true, description: 'Batch number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batchNumber?: string;

  @Field({ nullable: true, description: 'Expiry date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expiryDate?: Date;
}

/**
 * Input for treatment duration
 */
@InputType()
export class TreatmentDurationInput {
  @Field({ description: 'Treatment start date' })
  @IsDate()
  @Type(() => Date)
  startDate: Date;

  @Field({ nullable: true, description: 'Treatment end date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @Field({ description: 'Treatment frequency (e.g., "1x daily", "every 12h")' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  frequency: string;

  @Field(() => Int, { nullable: true, description: 'Total treatment days' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  totalDays?: number;
}

/**
 * Input for treatment details
 */
@InputType()
export class TreatmentDetailsInput {
  @Field(() => TreatmentMethod, { description: 'Treatment method' })
  @IsEnum(TreatmentMethod)
  method: TreatmentMethod;

  @Field(() => MedicationInput, { nullable: true, description: 'Medication details' })
  @IsOptional()
  @ValidateNested()
  @Type(() => MedicationInput)
  medication?: MedicationInput;

  @Field(() => TreatmentDurationInput, { description: 'Treatment duration' })
  @ValidateNested()
  @Type(() => TreatmentDurationInput)
  duration: TreatmentDurationInput;

  @Field(() => Int, { nullable: true, description: 'Withdrawal period in days (before harvest)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  withdrawalPeriod?: number;

  @Field({ nullable: true, description: 'Treatment instructions' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @Field(() => Float, { nullable: true, description: 'Treatment cost' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @Field({ nullable: true, description: 'Currency code' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}

/**
 * Input for affected population
 */
@InputType()
export class AffectedPopulationInput {
  @Field(() => Int, { description: 'Estimated number of affected fish' })
  @IsNumber()
  @Min(0)
  estimatedAffected: number;

  @Field(() => Float, { description: 'Affected percentage' })
  @IsNumber()
  @Min(0)
  @Max(100)
  affectedPercent: number;

  @Field(() => Int, { nullable: true, description: 'Mortality count related to this event' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mortalityCount?: number;

  @Field(() => Float, { nullable: true, description: 'Mortality percentage' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  mortalityPercent?: number;

  @Field({ nullable: true, description: 'Spread rate: slow, moderate, fast, contained' })
  @IsOptional()
  @IsString()
  spreadRate?: 'slow' | 'moderate' | 'fast' | 'contained';
}

/**
 * Input for lab results
 */
@InputType()
export class LabResultEntryInput {
  @Field({ description: 'Parameter name' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  parameter: string;

  @Field({ description: 'Result value' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  value: string;

  @Field({ nullable: true, description: 'Unit of measurement' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @Field({ nullable: true, description: 'Reference range' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @Field({ description: 'Result interpretation: normal, abnormal, positive, negative' })
  @IsNotEmpty()
  @IsString()
  interpretation: 'normal' | 'abnormal' | 'positive' | 'negative';
}

/**
 * Input for lab results
 */
@InputType()
export class LabResultsInput {
  @Field({ description: 'Sample type: tissue, water, mucus, blood, other' })
  @IsNotEmpty()
  @IsString()
  sampleType: 'tissue' | 'water' | 'mucus' | 'blood' | 'other';

  @Field({ description: 'Sample collection date' })
  @IsDate()
  @Type(() => Date)
  sampleDate: Date;

  @Field({ nullable: true, description: 'Laboratory name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  labName?: string;

  @Field({ description: 'Type of test performed' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  testType: string;

  @Field(() => [LabResultEntryInput], { description: 'Test results' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LabResultEntryInput)
  results: LabResultEntryInput[];

  @Field({ nullable: true, description: 'Lab conclusion' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  conclusion?: string;

  @Field({ nullable: true, description: 'Lab recommendations' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  recommendations?: string;
}

/**
 * Input for vet consultation
 */
@InputType()
export class VetConsultationInput {
  @Field({ description: 'Veterinarian name' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  vetName: string;

  @Field({ nullable: true, description: 'Veterinarian license number' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  vetLicense?: string;

  @Field({ description: 'Consultation date' })
  @IsDate()
  @Type(() => Date)
  consultationDate: Date;

  @Field({ nullable: true, description: 'Diagnosis' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  diagnosis?: string;

  @Field(() => [String], { nullable: true, description: 'Differential diagnosis options' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  differentialDiagnosis?: string[];

  @Field({ nullable: true, description: 'Recommended treatment' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  recommendedTreatment?: string;

  @Field({ description: 'Whether follow-up is required' })
  @IsBoolean()
  followUpRequired: boolean;

  @Field({ nullable: true, description: 'Follow-up date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  followUpDate?: Date;

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * Input for water quality snapshot
 */
@InputType()
export class WaterQualitySnapshotInput {
  @Field(() => Float, { nullable: true, description: 'Temperature (Celsius)' })
  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(40)
  temperature?: number;

  @Field(() => Float, { nullable: true, description: 'Dissolved oxygen (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true, description: 'pH value' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14)
  pH?: number;

  @Field(() => Float, { nullable: true, description: 'Ammonia (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  ammonia?: number;

  @Field(() => Float, { nullable: true, description: 'Nitrite (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  nitrite?: number;
}

// ============================================================================
// MAIN CREATE INPUT
// ============================================================================

@InputType()
export class CreateHealthEventInput {
  // -------------------------------------------------------------------------
  // LOCATION REFERENCES
  // -------------------------------------------------------------------------

  @Field(() => ID, { description: 'Batch ID (required)' })
  @IsUUID()
  batchId: string;

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

  @Field({ description: 'Event title' })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @Field({ nullable: true, description: 'Detailed description' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => HealthEventType, { description: 'Type of health event' })
  @IsEnum(HealthEventType)
  eventType: HealthEventType;

  @Field({ description: 'Event date' })
  @IsDate()
  @Type(() => Date)
  eventDate: Date;

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

  @Field({ nullable: true, description: 'Disease name (e.g., Columnaris, IHN, Saprolegnia)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  diseaseName?: string;

  @Field(() => HealthSeverity, { nullable: true, defaultValue: HealthSeverity.MODERATE, description: 'Severity level' })
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

  @Field(() => Int, { nullable: true, description: 'Number of affected fish (shortcut)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  affectedCount?: number;

  @Field(() => Int, { nullable: true, description: 'Mortality count (shortcut)' })
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

  @Field({ nullable: true, description: 'Medication name (shortcut)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  medication?: string;

  @Field({ nullable: true, defaultValue: false, description: 'Is currently under treatment' })
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

  // -------------------------------------------------------------------------
  // QUARANTINE
  // -------------------------------------------------------------------------

  @Field({ nullable: true, defaultValue: false, description: 'Is quarantined' })
  @IsOptional()
  @IsBoolean()
  isQuarantined?: boolean;

  @Field({ nullable: true, description: 'Quarantine start date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  quarantineStartDate?: Date;

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

  @Field({ nullable: true, defaultValue: false, description: 'Lab confirmed diagnosis' })
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

  @Field({ nullable: true, defaultValue: false, description: 'Vet has been notified' })
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

  @Field(() => HealthEventStatus, { nullable: true, defaultValue: HealthEventStatus.ACTIVE, description: 'Event status' })
  @IsOptional()
  @IsEnum(HealthEventStatus)
  status?: HealthEventStatus;

  // -------------------------------------------------------------------------
  // RELATED EVENTS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Parent event ID (for linked events)' })
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

  @Field({ nullable: true, defaultValue: 'TRY', description: 'Currency code' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  // -------------------------------------------------------------------------
  // USER INFORMATION
  // -------------------------------------------------------------------------

  // WHY: reportedBy is the AUTHENTICATED reporter — HealthEventService authoritatively
  // sets it from the JWT subject (req user.sub), so any client value is overridden.
  // A required @IsUUID rejected the frontend's placeholder ('current-user') at the
  // ValidationPipe before the service could run. WHAT: make it optional and drop the
  // format constraint; the server is the source of truth.
  @Field(() => ID, { nullable: true, description: 'Deprecated: server sets the reporter from the JWT subject' })
  @IsOptional()
  @IsString()
  reportedBy?: string;

  @Field({ nullable: true, description: 'Observation date/time (if different from event date)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  observedAt?: Date;

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

  @Field({ nullable: true, defaultValue: false, description: 'Follow-up required' })
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @Field({ nullable: true, description: 'Next follow-up date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  followUpDate?: Date;
}
