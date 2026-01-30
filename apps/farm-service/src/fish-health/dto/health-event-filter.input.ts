/**
 * HealthEventFilter Input DTO
 *
 * DTO for filtering and querying health events.
 * Supports pagination, date ranges, and multiple filter criteria.
 *
 * @module FishHealth
 */
import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsOptional,
  IsUUID,
  IsDate,
  IsEnum,
  IsInt,
  IsBoolean,
  IsString,
  IsArray,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  HealthEventType,
  HealthSeverity,
  HealthEventStatus,
  DiseaseCategory,
} from '../entities/health-event.entity';

@InputType()
export class HealthEventFilterInput {
  // -------------------------------------------------------------------------
  // LOCATION FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by Batch ID' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => [ID], { nullable: true, description: 'Filter by multiple Batch IDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  batchIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Filter by Tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => [ID], { nullable: true, description: 'Filter by multiple Tank IDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tankIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Filter by Pond ID' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by Site ID' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  // -------------------------------------------------------------------------
  // EVENT TYPE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => HealthEventType, { nullable: true, description: 'Filter by event type' })
  @IsOptional()
  @IsEnum(HealthEventType)
  eventType?: HealthEventType;

  @Field(() => [HealthEventType], { nullable: true, description: 'Filter by multiple event types' })
  @IsOptional()
  @IsArray()
  @IsEnum(HealthEventType, { each: true })
  eventTypes?: HealthEventType[];

  // -------------------------------------------------------------------------
  // SEVERITY AND STATUS FILTERS
  // -------------------------------------------------------------------------

  @Field(() => HealthSeverity, { nullable: true, description: 'Filter by severity' })
  @IsOptional()
  @IsEnum(HealthSeverity)
  severity?: HealthSeverity;

  @Field(() => [HealthSeverity], { nullable: true, description: 'Filter by multiple severities' })
  @IsOptional()
  @IsArray()
  @IsEnum(HealthSeverity, { each: true })
  severities?: HealthSeverity[];

  @Field(() => HealthEventStatus, { nullable: true, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(HealthEventStatus)
  status?: HealthEventStatus;

  @Field(() => [HealthEventStatus], { nullable: true, description: 'Filter by multiple statuses' })
  @IsOptional()
  @IsArray()
  @IsEnum(HealthEventStatus, { each: true })
  statuses?: HealthEventStatus[];

  // -------------------------------------------------------------------------
  // DISEASE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => DiseaseCategory, { nullable: true, description: 'Filter by disease category' })
  @IsOptional()
  @IsEnum(DiseaseCategory)
  diseaseCategory?: DiseaseCategory;

  @Field(() => [DiseaseCategory], { nullable: true, description: 'Filter by multiple disease categories' })
  @IsOptional()
  @IsArray()
  @IsEnum(DiseaseCategory, { each: true })
  diseaseCategories?: DiseaseCategory[];

  @Field({ nullable: true, description: 'Filter by disease name (partial match)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  diseaseName?: string;

  // -------------------------------------------------------------------------
  // DATE FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Event date from (inclusive)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  fromDate?: Date;

  @Field({ nullable: true, description: 'Event date to (inclusive)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  toDate?: Date;

  @Field({ nullable: true, description: 'Created date from' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdFrom?: Date;

  @Field({ nullable: true, description: 'Created date to' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdTo?: Date;

  // -------------------------------------------------------------------------
  // TREATMENT FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Filter by under treatment status' })
  @IsOptional()
  @IsBoolean()
  isUnderTreatment?: boolean;

  @Field({ nullable: true, description: 'Filter by quarantine status' })
  @IsOptional()
  @IsBoolean()
  isQuarantined?: boolean;

  @Field({ nullable: true, description: 'Filter by lab confirmed status' })
  @IsOptional()
  @IsBoolean()
  labConfirmed?: boolean;

  @Field({ nullable: true, description: 'Filter by vet notified status' })
  @IsOptional()
  @IsBoolean()
  vetNotified?: boolean;

  // -------------------------------------------------------------------------
  // FOLLOW-UP FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Filter by follow-up required' })
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @Field({ nullable: true, description: 'Filter for overdue follow-ups' })
  @IsOptional()
  @IsBoolean()
  followUpOverdue?: boolean;

  @Field({ nullable: true, description: 'Follow-up date from' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  followUpFrom?: Date;

  @Field({ nullable: true, description: 'Follow-up date to' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  followUpTo?: Date;

  // -------------------------------------------------------------------------
  // USER FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by reporter user ID' })
  @IsOptional()
  @IsUUID()
  reportedBy?: string;

  // -------------------------------------------------------------------------
  // TEXT SEARCH
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Search in title, description, and notes' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  searchText?: string;

  // -------------------------------------------------------------------------
  // RELATED EVENTS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by parent event ID' })
  @IsOptional()
  @IsUUID()
  parentEventId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by related alert incident ID' })
  @IsOptional()
  @IsUUID()
  alertIncidentId?: string;

  // -------------------------------------------------------------------------
  // SPECIAL FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Filter for active events only (ACTIVE or MONITORING)' })
  @IsOptional()
  @IsBoolean()
  activeOnly?: boolean;

  @Field({ nullable: true, description: 'Filter for critical events (CRITICAL or SEVERE severity)' })
  @IsOptional()
  @IsBoolean()
  criticalOnly?: boolean;

  @Field({ nullable: true, description: 'Filter for events with withdrawal period affecting harvest' })
  @IsOptional()
  @IsBoolean()
  hasWithdrawalPeriod?: boolean;

  // -------------------------------------------------------------------------
  // PAGINATION
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true, defaultValue: 50, description: 'Maximum number of records to return' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Number of records to skip' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  // -------------------------------------------------------------------------
  // SORTING
  // -------------------------------------------------------------------------

  @Field({ nullable: true, defaultValue: 'eventDate', description: 'Field to sort by' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC', description: 'Sort direction: ASC or DESC' })
  @IsOptional()
  @IsString()
  sortDirection?: 'ASC' | 'DESC';
}
