/**
 * HarvestPlanFilter Input DTO
 *
 * DTO for filtering and querying harvest plans.
 * Supports pagination, date ranges, and multiple filter criteria.
 *
 * @module Harvest
 */
import { InputType, Field, ID, Int, Float } from '@nestjs/graphql';
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
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  HarvestPlanStatus,
  HarvestType,
  HarvestMethod,
  ProductForm,
} from '../entities/harvest-plan.entity';

@InputType()
export class HarvestPlanFilterInput {
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

  // -------------------------------------------------------------------------
  // STATUS FILTERS
  // -------------------------------------------------------------------------

  @Field(() => HarvestPlanStatus, { nullable: true, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(HarvestPlanStatus)
  status?: HarvestPlanStatus;

  @Field(() => [HarvestPlanStatus], { nullable: true, description: 'Filter by multiple statuses' })
  @IsOptional()
  @IsArray()
  @IsEnum(HarvestPlanStatus, { each: true })
  statuses?: HarvestPlanStatus[];

  // -------------------------------------------------------------------------
  // TYPE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => HarvestType, { nullable: true, description: 'Filter by harvest type' })
  @IsOptional()
  @IsEnum(HarvestType)
  harvestType?: HarvestType;

  @Field(() => [HarvestType], { nullable: true, description: 'Filter by multiple harvest types' })
  @IsOptional()
  @IsArray()
  @IsEnum(HarvestType, { each: true })
  harvestTypes?: HarvestType[];

  @Field(() => HarvestMethod, { nullable: true, description: 'Filter by harvest method' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  harvestMethod?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, description: 'Filter by product form' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  // -------------------------------------------------------------------------
  // DATE FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Planned date from (inclusive)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  plannedDateFrom?: Date;

  @Field({ nullable: true, description: 'Planned date to (inclusive)' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  plannedDateTo?: Date;

  @Field({ nullable: true, description: 'Confirmed date from' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  confirmedDateFrom?: Date;

  @Field({ nullable: true, description: 'Confirmed date to' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  confirmedDateTo?: Date;

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
  // ESTIMATE FILTERS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Minimum estimated biomass (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minEstimatedBiomass?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum estimated biomass (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxEstimatedBiomass?: number;

  @Field(() => Int, { nullable: true, description: 'Minimum estimated quantity' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minEstimatedQuantity?: number;

  @Field(() => Int, { nullable: true, description: 'Maximum estimated quantity' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxEstimatedQuantity?: number;

  // -------------------------------------------------------------------------
  // USER FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by creator user ID' })
  @IsOptional()
  @IsUUID()
  createdBy?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by approver user ID' })
  @IsOptional()
  @IsUUID()
  approvedBy?: string;

  // -------------------------------------------------------------------------
  // CUSTOMER FILTERS
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true, description: 'Filter by customer ID' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by order ID' })
  @IsOptional()
  @IsString()
  orderId?: string;

  // -------------------------------------------------------------------------
  // TEXT SEARCH
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Search in plan code, name, and notes' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  searchText?: string;

  // -------------------------------------------------------------------------
  // SPECIAL FILTERS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Filter for plans with confirmed date' })
  @IsOptional()
  @IsBoolean()
  hasConfirmedDate?: boolean;

  @Field({ nullable: true, description: 'Filter for approved plans only' })
  @IsOptional()
  @IsBoolean()
  approvedOnly?: boolean;

  @Field({ nullable: true, description: 'Filter for active plans (not completed/cancelled)' })
  @IsOptional()
  @IsBoolean()
  activeOnly?: boolean;

  @Field({ nullable: true, description: 'Filter for overdue plans (planned date in the past, not completed)' })
  @IsOptional()
  @IsBoolean()
  overdueOnly?: boolean;

  @Field({ nullable: true, description: 'Filter for upcoming plans (within next N days)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  upcomingDays?: number;

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

  @Field({ nullable: true, defaultValue: 'plannedDate', description: 'Field to sort by' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'ASC', description: 'Sort direction: ASC or DESC' })
  @IsOptional()
  @IsString()
  sortDirection?: 'ASC' | 'DESC';
}
