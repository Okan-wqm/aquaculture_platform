/**
 * CreateHarvestPlan Input DTO
 *
 * DTO for creating new harvest plans.
 * Includes all fields for planning harvests, estimates, and logistics.
 *
 * @module Harvest
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
  HarvestPlanStatus,
  HarvestType,
  HarvestMethod,
  ProductForm,
} from '../entities/harvest-plan.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

/**
 * Input for harvest criteria (target weight and quantity)
 */
@InputType()
export class HarvestCriteriaInput {
  @Field(() => Float, { description: 'Minimum target weight in grams' })
  @IsNumber()
  @Min(0)
  targetWeightMin!: number;

  @Field(() => Float, { description: 'Maximum target weight in grams' })
  @IsNumber()
  @Min(0)
  targetWeightMax!: number;

  @Field(() => Float, { description: 'Ideal target weight in grams' })
  @IsNumber()
  @Min(0)
  targetWeightTarget!: number;

  @Field(() => Float, { nullable: true, description: 'Target quantity value' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  targetQuantityValue?: number;

  @Field({ nullable: true, description: 'Target quantity unit: pieces, kg, or percent' })
  @IsOptional()
  @IsString()
  targetQuantityUnit?: 'pieces' | 'kg' | 'percent';

  @Field({ nullable: true, description: 'Quality grade requirement' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  qualityGrade?: string;

  @Field(() => Float, { nullable: true, description: 'Minimum condition factor (K factor)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumConditionFactor?: number;
}

/**
 * Input for harvest estimates
 */
@InputType()
export class HarvestEstimatesInput {
  @Field(() => Int, { description: 'Estimated quantity (pieces)' })
  @IsNumber()
  @Min(0)
  estimatedQuantity!: number;

  @Field(() => Float, { description: 'Estimated biomass in kg' })
  @IsNumber()
  @Min(0)
  estimatedBiomass!: number;

  @Field(() => Float, { description: 'Estimated average weight in grams' })
  @IsNumber()
  @Min(0)
  estimatedAvgWeight!: number;

  @Field(() => Float, { description: 'Estimated yield percentage (after processing)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  estimatedYield!: number;

  @Field({ description: 'Confidence level: low, medium, or high' })
  @IsString()
  confidenceLevel!: 'low' | 'medium' | 'high';

  @Field({ nullable: true, description: 'Date of measurement these estimates are based on' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  basedOnMeasurementDate?: Date;
}

/**
 * Input for financial projection
 */
@InputType()
export class FinancialProjectionInput {
  @Field(() => Float, { description: 'Estimated revenue' })
  @IsNumber()
  @Min(0)
  estimatedRevenue!: number;

  @Field(() => Float, { description: 'Estimated unit price' })
  @IsNumber()
  @Min(0)
  estimatedPrice!: number;

  @Field({ description: 'Price unit: per_kg or per_piece' })
  @IsString()
  priceUnit!: 'per_kg' | 'per_piece';

  @Field(() => Float, { description: 'Estimated cost' })
  @IsNumber()
  @Min(0)
  estimatedCost!: number;

  @Field(() => Float, { description: 'Estimated profit' })
  @IsNumber()
  estimatedProfit!: number;

  @Field(() => Float, { description: 'Margin percentage' })
  @IsNumber()
  margin!: number;

  @Field({ description: 'Currency code (e.g., TRY, USD, EUR)' })
  @IsString()
  @MaxLength(3)
  currency!: string;
}

/**
 * Input for logistics plan
 */
@InputType()
export class LogisticsPlanInput {
  @Field({ nullable: true, description: 'Harvest start time (e.g., "06:00")' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  harvestStartTime?: string;

  @Field(() => Float, { nullable: true, description: 'Expected duration in hours' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  expectedDuration?: number;

  @Field(() => [String], { nullable: true, description: 'Required equipment list' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredEquipment?: string[];

  @Field(() => Int, { nullable: true, description: 'Required personnel count' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  requiredPersonnel?: number;

  @Field({ nullable: true, description: 'Transport type: truck, boat, or container' })
  @IsOptional()
  @IsString()
  transportType?: 'truck' | 'boat' | 'container';

  @Field(() => Float, { nullable: true, description: 'Transport capacity in kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  transportCapacity?: number;

  @Field({ nullable: true, description: 'Destination type: processing, market, direct_sale, or export' })
  @IsOptional()
  @IsString()
  destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';

  @Field({ nullable: true, description: 'Destination address' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  destinationAddress?: string;

  @Field({ nullable: true, description: 'Cold chain required' })
  @IsOptional()
  @IsBoolean()
  coldChainRequired?: boolean;
}

/**
 * Input for customer order information
 */
@InputType()
export class CustomerOrderInput {
  @Field({ nullable: true, description: 'Customer ID' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerId?: string;

  @Field({ nullable: true, description: 'Customer name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @Field({ nullable: true, description: 'Order ID' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  orderId?: string;

  @Field(() => Float, { nullable: true, description: 'Order quantity' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  orderQuantity?: number;

  @Field({ nullable: true, description: 'Order unit' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  orderUnit?: string;

  @Field({ nullable: true, description: 'Delivery date' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  deliveryDate?: Date;

  @Field(() => Float, { nullable: true, description: 'Contract price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  contractPrice?: number;
}

/**
 * Input for quality requirements
 */
@InputType()
export class QualityRequirementsInput {
  @Field(() => [String], { nullable: true, description: 'Required certifications (MSC, ASC, Organic, etc.)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  certifications?: string[];

  @Field({ nullable: true, description: 'Size grading required' })
  @IsOptional()
  @IsBoolean()
  sizeGrading?: boolean;

  @Field({ nullable: true, description: 'Quality inspection required' })
  @IsOptional()
  @IsBoolean()
  qualityInspection?: boolean;

  @Field({ nullable: true, description: 'Traceability required' })
  @IsOptional()
  @IsBoolean()
  traceabilityRequired?: boolean;

  @Field(() => [String], { nullable: true, description: 'Specific quality requirements' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specificRequirements?: string[];
}

// ============================================================================
// MAIN CREATE INPUT
// ============================================================================

@InputType()
export class CreateHarvestPlanInput {
  // -------------------------------------------------------------------------
  // BASIC INFORMATION
  // -------------------------------------------------------------------------

  @Field({ description: 'Plan name' })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name!: string;

  @Field({ nullable: true, description: 'Plan description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  // -------------------------------------------------------------------------
  // BATCH REFERENCE
  // -------------------------------------------------------------------------

  @Field(() => ID, { description: 'Batch ID to harvest' })
  @IsUUID()
  batchId!: string;

  // -------------------------------------------------------------------------
  // STATUS AND TYPE
  // -------------------------------------------------------------------------

  @Field(() => HarvestPlanStatus, { nullable: true, defaultValue: HarvestPlanStatus.DRAFT, description: 'Plan status' })
  @IsOptional()
  @IsEnum(HarvestPlanStatus)
  status?: HarvestPlanStatus;

  @Field(() => HarvestType, { nullable: true, defaultValue: HarvestType.FULL, description: 'Harvest type' })
  @IsOptional()
  @IsEnum(HarvestType)
  harvestType?: HarvestType;

  // -------------------------------------------------------------------------
  // DATES
  // -------------------------------------------------------------------------

  @Field({ description: 'Planned harvest date' })
  @IsDate()
  @Type(() => Date)
  plannedDate!: Date;

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

  @Field(() => HarvestCriteriaInput, { description: 'Harvest criteria' })
  @ValidateNested()
  @Type(() => HarvestCriteriaInput)
  criteria!: HarvestCriteriaInput;

  @Field(() => HarvestMethod, { nullable: true, description: 'Harvest method' })
  @IsOptional()
  @IsEnum(HarvestMethod)
  harvestMethod?: HarvestMethod;

  @Field(() => ProductForm, { nullable: true, defaultValue: ProductForm.FRESH_WHOLE, description: 'Product form' })
  @IsOptional()
  @IsEnum(ProductForm)
  productForm?: ProductForm;

  // -------------------------------------------------------------------------
  // ESTIMATES
  // -------------------------------------------------------------------------

  @Field(() => HarvestEstimatesInput, { description: 'Harvest estimates' })
  @ValidateNested()
  @Type(() => HarvestEstimatesInput)
  estimates!: HarvestEstimatesInput;

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
