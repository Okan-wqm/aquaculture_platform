import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsInt,
  IsObject,
  IsUUID,
  IsBoolean,
  IsDate,
  IsEnum,
  IsISO8601,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';

import {
  DiscountAppliesTo,
  DiscountDuration,
  DiscountType,
} from '../entities/discount-code.entity';
import { BillingCycle, PlanTier, PlanVisibility } from '../entities/plan-definition.entity';
import { PricingMetricType } from '../entities/pricing-metric.enum';

// ============================================================================
// Nested value objects (CONTRACT-CRITICAL-003)
//
// An `interface`-typed @Body() compiles to `design:paramtypes = Object`:
// ValidationPipe skips it entirely and Swagger emits `{}`. Every nested shape
// below is therefore a class with its own validators, reached through
// @ValidateNested + @Type so `whitelist` / `forbidNonWhitelisted` apply at
// every level rather than only at the envelope.
// ============================================================================

export class PlanLimitsDto {
  /** -1 means unlimited, which is why the floor is -1 and not 0. */
  @IsInt() @Min(-1) maxUsers!: number;
  @IsInt() @Min(-1) maxFarms!: number;
  @IsInt() @Min(-1) maxPonds!: number;
  @IsInt() @Min(-1) maxSensors!: number;
  @IsInt() @Min(-1) maxModules!: number;
  @IsInt() @Min(-1) storageGB!: number;
  @IsInt() @Min(-1) dataRetentionDays!: number;
  @IsInt() @Min(-1) apiRateLimit!: number;
  @IsBoolean() alertsEnabled!: boolean;
  @IsBoolean() reportsEnabled!: boolean;
  @IsBoolean() customBrandingEnabled!: boolean;
  @IsBoolean() apiAccessEnabled!: boolean;
  @IsBoolean() customIntegrationsEnabled!: boolean;
  @IsBoolean() ssoEnabled!: boolean;
  @IsBoolean() auditLogEnabled!: boolean;
  @IsBoolean() prioritySupport!: boolean;
  @IsBoolean() dedicatedAccountManager!: boolean;
}

export class PlanCyclePricingDto {
  @IsNumber() @Min(0) basePrice!: number;
  @IsNumber() @Min(0) perUserPrice!: number;
  @IsNumber() @Min(0) perFarmPrice!: number;
  @IsNumber() @Min(0) perModulePrice!: number;
}

export class PlanDiscountedCyclePricingDto extends PlanCyclePricingDto {
  @IsNumber() @Min(0) @Max(100) discountPercent!: number;
}

export class PlanPricingDto {
  @ValidateNested() @Type(() => PlanCyclePricingDto) monthly!: PlanCyclePricingDto;
  @ValidateNested()
  @Type(() => PlanDiscountedCyclePricingDto)
  quarterly!: PlanDiscountedCyclePricingDto;
  @ValidateNested()
  @Type(() => PlanDiscountedCyclePricingDto)
  semiAnnual!: PlanDiscountedCyclePricingDto;
  @ValidateNested()
  @Type(() => PlanDiscountedCyclePricingDto)
  annual!: PlanDiscountedCyclePricingDto;
  @IsString() @MaxLength(10) currency!: string;
}

export class PlanAddOnDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsString() @MaxLength(1000) description!: string;
  @IsNumber() @Min(0) price!: number;
  @IsEnum(BillingCycle) billingCycle!: BillingCycle;
}

export class PlanFeaturesDto {
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) coreFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) advancedFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) premiumFeatures!: string[];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlanAddOnDto)
  addOns!: PlanAddOnDto[];
}

export class PricingMetricDto {
  @IsEnum(PricingMetricType) type!: PricingMetricType;
  @IsNumber() @Min(0) price!: number;
  @IsString() @MaxLength(10) currency!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) minQuantity?: number;
  @IsOptional() @IsInt() @Min(0) maxQuantity?: number;
  @IsOptional() @IsInt() @Min(0) includedQuantity?: number;
}

/**
 * Multipliers keyed by tier. The property names ARE the `PlanTier` values, so
 * this class is structurally the `TierMultipliers` index the entity declares.
 */
export class TierMultipliersDto {
  @IsOptional() @IsNumber() @Min(0) free?: number;
  @IsOptional() @IsNumber() @Min(0) starter?: number;
  @IsOptional() @IsNumber() @Min(0) professional?: number;
  @IsOptional() @IsNumber() @Min(0) enterprise?: number;
  @IsOptional() @IsNumber() @Min(0) custom?: number;
}

export class ModuleQuantitiesDto {
  @IsOptional() @IsInt() @Min(0) users?: number;
  @IsOptional() @IsInt() @Min(0) farms?: number;
  @IsOptional() @IsInt() @Min(0) ponds?: number;
  @IsOptional() @IsInt() @Min(0) sensors?: number;
  @IsOptional() @IsInt() @Min(0) devices?: number;
  @IsOptional() @IsInt() @Min(0) storageGb?: number;
  @IsOptional() @IsInt() @Min(0) apiCalls?: number;
  @IsOptional() @IsInt() @Min(0) alerts?: number;
  @IsOptional() @IsInt() @Min(0) reports?: number;
  @IsOptional() @IsInt() @Min(0) integrations?: number;
}

export class ModuleSelectionDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsOptional() @IsString() @MaxLength(255) moduleName?: string;
  @ValidateNested() @Type(() => ModuleQuantitiesDto) quantities!: ModuleQuantitiesDto;
}

export class CustomPlanModuleDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsString() @MaxLength(255) moduleName!: string;
  @ValidateNested() @Type(() => ModuleQuantitiesDto) quantities!: ModuleQuantitiesDto;
}

export class BillingAddressDto {
  @IsString() @MaxLength(255) companyName!: string;
  @IsOptional() @IsString() @MaxLength(255) attention?: string;
  @IsString() @MaxLength(255) street!: string;
  @IsString() @MaxLength(120) city!: string;
  @IsString() @MaxLength(120) state!: string;
  @IsString() @MaxLength(32) postalCode!: string;
  @IsString() @MaxLength(120) country!: string;
  @IsOptional() @IsString() @MaxLength(64) taxId?: string;
}

export class InvoiceLineItemDto {
  @IsString() @MaxLength(500) description!: string;
  @IsNumber() @Min(0) quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() @MaxLength(100) productCode?: string;
}

export class InvoiceTaxDto {
  @IsNumber() @Min(0) @Max(100) taxRate!: number;
  @IsOptional() @IsString() @MaxLength(64) taxId?: string;
  @IsOptional() @IsString() @MaxLength(120) taxName?: string;
}

// ============================================================================
// Plans
//
// The actor (`createdBy` / `updatedBy`) is NOT a property of any request body:
// it comes from the verified principal (ADMIN-CRITICAL-008), and the ESLint
// rule `no-actor-in-input-dto` makes declaring it here a build error.
// ============================================================================

export class CreatePlanDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsEnum(PlanTier) tier!: PlanTier;
  @IsOptional() @IsEnum(PlanVisibility) visibility?: PlanVisibility;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @ValidateNested() @Type(() => PlanLimitsDto) limits!: PlanLimitsDto;
  @ValidateNested() @Type(() => PlanPricingDto) pricing!: PlanPricingDto;
  @ValidateNested() @Type(() => PlanFeaturesDto) features!: PlanFeaturesDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(1000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
}

/** An update may send a subset of a nested object, so the nested shapes are partial. */
export class PartialPlanLimitsDto extends PartialType(PlanLimitsDto) {}
export class PartialPlanPricingDto extends PartialType(PlanPricingDto) {}
export class PartialPlanFeaturesDto extends PartialType(PlanFeaturesDto) {}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsEnum(PlanVisibility) visibility?: PlanVisibility;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => PartialPlanLimitsDto) limits?: PartialPlanLimitsDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => PartialPlanPricingDto)
  pricing?: PartialPlanPricingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => PartialPlanFeaturesDto)
  features?: PartialPlanFeaturesDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(1000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
}

// ============================================================================
// Discount codes
// ============================================================================

/** Everything a discount code carries except its code — the bulk-create template. */
export class DiscountCodeTemplateDto {
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsEnum(DiscountType) discountType!: DiscountType;
  @IsNumber() @Min(0) discountValue!: number;
  @IsOptional() @IsEnum(DiscountAppliesTo) appliesTo?: DiscountAppliesTo;
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(200)
  applicablePlanIds?: string[];
  @IsOptional() @IsEnum(DiscountDuration) duration?: DiscountDuration;
  @IsOptional() @IsInt() @Min(1) @Max(120) durationInMonths?: number;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional() @IsNumber() @Min(0) minimumOrderAmount?: number;
  @IsOptional() @IsString() @MaxLength(100) campaignId?: string;
  @IsOptional() @IsString() @MaxLength(255) campaignName?: string;
  @IsOptional() @IsBoolean() isReferralCode?: boolean;
  @IsOptional() @IsUUID('4') referrerId?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class CreateDiscountCodeDto extends DiscountCodeTemplateDto {
  @IsString() @MaxLength(64) code!: string;
}

export class UpdateDiscountCodeDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

// ============================================================================
// Module pricing + quotes
// ============================================================================

export class SetModulePricingDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PricingMetricDto)
  pricingMetrics!: PricingMetricDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => TierMultipliersDto)
  tierMultipliers?: TierMultipliersDto;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() effectiveTo?: Date | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class QuoteRequest {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ModuleSelectionDto)
  modules!: ModuleSelectionDto[];
  @IsEnum(PlanTier) tier!: PlanTier;
  @IsEnum(BillingCycle) billingCycle!: BillingCycle;
  @IsOptional() @IsString() @MaxLength(64) discountCode?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxRate?: number;
}

// ============================================================================
// Subscriptions + custom plans
// ============================================================================

export class PlanChangeRequest {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsUUID('4') currentPlanId!: string;
  @IsUUID('4') newPlanId!: string;
  @IsOptional() @IsEnum(BillingCycle) newBillingCycle?: BillingCycle;
  @IsOptional() @IsString() @MaxLength(64) discountCode?: string;
  @IsOptional() @IsBoolean() effectiveImmediately?: boolean;
}

export class CreateCustomPlanDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID('4') basePlanId?: string;
  @IsOptional() @IsEnum(PlanTier) tier?: PlanTier;
  @IsOptional() @IsEnum(BillingCycle) billingCycle?: BillingCycle;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomPlanModuleDto)
  modules!: CustomPlanModuleDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) discountReason?: string;
  @Type(() => Date) @IsDate() validFrom!: Date;
  @IsOptional() @Type(() => Date) @IsDate() validTo?: Date;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateCustomPlanDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomPlanModuleDto)
  modules?: CustomPlanModuleDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) discountReason?: string;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validTo?: Date;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

// ============================================================================
// Invoices + payments
// ============================================================================

export class CreateInvoiceDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional() @IsUUID('4') subscriptionId?: string;
  @ValidateNested() @Type(() => BillingAddressDto) billingAddress!: BillingAddressDto;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemDto)
  lineItems!: InvoiceLineItemDto[];
  @IsOptional() @ValidateNested() @Type(() => InvoiceTaxDto) tax?: InvoiceTaxDto;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsString() @MaxLength(64) discountCode?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsISO8601() dueDate!: string;
  @IsISO8601() periodStart!: string;
  @IsISO8601() periodEnd!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class RecordPaymentDto {
  @IsUUID('4') invoiceId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsString() @MaxLength(100) paymentMethod!: string;
  @IsOptional() @IsISO8601() paymentDate?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class RefundPaymentDto {
  @IsUUID('4') paymentId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsString() @MaxLength(500) reason!: string;
}

// ============================================================================
// Module Pricing
// ============================================================================

export class UpdateModulePricingDto {
  @IsOptional()
  @IsUUID('4')
  moduleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  moduleCode?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PricingMetricDto)
  pricingMetrics?: PricingMetricDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TierMultipliersDto)
  tierMultipliers?: TierMultipliersDto;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  effectiveFrom?: Date;

  @IsOptional()
  effectiveTo?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SeedModulePricingDto {
  @IsObject()
  moduleIdMap!: Record<string, string>;
}

// ============================================================================
// Plan Compare
// ============================================================================

export class ComparePlansDto {
  @IsUUID('4')
  currentPlanId!: string;

  @IsUUID('4')
  newPlanId!: string;
}

// ============================================================================
// Discount Codes
// ============================================================================

export class ValidateDiscountCodeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  orderAmount?: number;
}

export class ApplyDiscountCodeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsNumber()
  @Min(0)
  originalAmount!: number;

  @IsOptional()
  @IsUUID('4')
  subscriptionId?: string;

  @IsOptional()
  @IsUUID('4')
  invoiceId?: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;
}

export class GenerateDiscountCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefix?: string;

  @IsOptional()
  @IsNumber()
  @Min(4)
  @Max(32)
  length?: number;
}

export class BulkCreateDiscountCodesDto {
  @IsNumber()
  @Min(1)
  @Max(1000)
  count!: number;

  @ValidateNested()
  @Type(() => DiscountCodeTemplateDto)
  template!: DiscountCodeTemplateDto;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  codePrefix?: string;
}

// ============================================================================
// Subscriptions
// ============================================================================

export class CancelSubscriptionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  cancelImmediately?: boolean;
}

export class ExtendTrialDto {
  @IsNumber()
  @Min(1)
  @Max(365)
  additionalDays!: number;
}

// ============================================================================
// Pricing Calculator
// ============================================================================

export class QuickEstimateDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  moduleCodes!: string[];

  @IsEnum(PlanTier)
  tier!: PlanTier;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModuleQuantitiesDto)
  quantities?: ModuleQuantitiesDto;
}

export class ComparePricingDto {
  @ValidateNested()
  @Type(() => QuoteRequest)
  config1!: QuoteRequest;

  @ValidateNested()
  @Type(() => QuoteRequest)
  config2!: QuoteRequest;
}

// ============================================================================
// Custom Plans
// ============================================================================

export class RejectCustomPlanDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class CloneCustomPlanDto {
  @IsUUID('4')
  newTenantId!: string;
}

// ============================================================================
// Invoices
// ============================================================================

export class MarkInvoicePaidDto {
  @IsNumber()
  @Min(0)
  amount!: number;
}

export class VoidInvoiceDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

// ============================================================================
// Users (password reset in billing context)
// ============================================================================

export class ResetPasswordByAdminDto {
  @IsString()
  @MaxLength(255)
  newPassword!: string;
}
