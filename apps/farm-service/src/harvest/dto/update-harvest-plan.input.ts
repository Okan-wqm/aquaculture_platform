/**
 * UpdateHarvestPlan Input DTO
 *
 * DTO for updating existing harvest plans.
 * All fields are optional except the ID.
 *
 * @module Harvest
 */
import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDate,
  IsEnum,
  IsNumber,
  IsArray,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  HarvestPlanStatus,
  HarvestType,
  HarvestMethod,
  ProductForm,
} from '../entities/harvest-plan.entity';
import {
  HarvestCriteriaInput,
  HarvestEstimatesInput,
  FinancialProjectionInput,
  LogisticsPlanInput,
  CustomerOrderInput,
  QualityRequirementsInput,
} from './create-harvest-plan.input';

@InputType()
export class UpdateHarvestPlanInput {
  @Field(() => ID, { description: 'Harvest Plan ID' })
  @IsUUID()
  id!: string;

  // -------------------------------------------------------------------------
  // BASIC INFORMATION
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Plan name' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name?: string;

  @Field({ nullable: true, description: 'Plan description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  // -------------------------------------------------------------------------
  // STATUS AND TYPE
  // -------------------------------------------------------------------------

  @Field(() => HarvestPlanStatus, { nullable: true, description: 'Plan status' })
  @IsOptional()
  @IsEnum(HarvestPlanStatus)
  status?: HarvestPlanStatus;

  @Field(() => HarvestType, { nullable: true, description: 'Harvest type' })
  @IsOptional()
  @IsEnum(HarvestType)
  harvestType?: HarvestType;

  // -------------------------------------------------------------------------
  // DATES
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Planned harvest date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  plannedDate?: Date;

  @Field({ nullable: true, description: 'Confirmed harvest date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  confirmedDate?: Date;

  @Field({ nullable: true, description: 'Flexible window start date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  windowStartDate?: Date;

  @Field({ nullable: true, description: 'Flexible window end date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  windowEndDate?: Date;

  // -------------------------------------------------------------------------
  // HARVEST CRITERIA
  // -------------------------------------------------------------------------

  @Field(() => HarvestCriteriaInput, { nullable: true, description: 'Harvest criteria' })
  @IsOptional()
  @ValidateNested()
  @Type(() => HarvestCriteriaInput)
  criteria?: HarvestCriteriaInput;

  @Field(() => HarvestMethod, { nullable: true, description: 'Harvest method' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  harvestMethod?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, description: 'Product form' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  // -------------------------------------------------------------------------
  // ESTIMATES
  // -------------------------------------------------------------------------

  @Field(() => HarvestEstimatesInput, { nullable: true, description: 'Harvest estimates' })
  @IsOptional()
  @ValidateNested()
  @Type(() => HarvestEstimatesInput)
  estimates?: HarvestEstimatesInput;

  // -------------------------------------------------------------------------
  // FINANCIAL PROJECTION
  // -------------------------------------------------------------------------

  @Field(() => FinancialProjectionInput, { nullable: true, description: 'Financial projection' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FinancialProjectionInput)
  financialProjection?: FinancialProjectionInput;

  // -------------------------------------------------------------------------
  // LOGISTICS
  // -------------------------------------------------------------------------

  @Field(() => LogisticsPlanInput, { nullable: true, description: 'Logistics plan' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LogisticsPlanInput)
  logistics?: LogisticsPlanInput;

  // -------------------------------------------------------------------------
  // CUSTOMER ORDER
  // -------------------------------------------------------------------------

  @Field(() => CustomerOrderInput, { nullable: true, description: 'Customer order information' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerOrderInput)
  customerOrder?: CustomerOrderInput;

  // -------------------------------------------------------------------------
  // QUALITY REQUIREMENTS
  // -------------------------------------------------------------------------

  @Field(() => QualityRequirementsInput, { nullable: true, description: 'Quality requirements' })
  @IsOptional()
  @ValidateNested()
  @Type(() => QualityRequirementsInput)
  qualityRequirements?: QualityRequirementsInput;

  // -------------------------------------------------------------------------
  // ACTUAL HARVEST DATA (post-harvest update)
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true, description: 'Actual quantity harvested' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualQuantityHarvested?: number;

  @Field(() => Float, { nullable: true, description: 'Actual biomass harvested (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualBiomassHarvested?: number;

  @Field(() => Float, { nullable: true, description: 'Actual average weight (grams)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualAvgWeight?: number;

  // -------------------------------------------------------------------------
  // ADDITIONAL INFORMATION
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'Additional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @Field(() => [String], { nullable: true, description: 'Attachment URLs' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}
