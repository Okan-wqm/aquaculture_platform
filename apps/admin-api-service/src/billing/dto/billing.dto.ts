import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsUUID,
  IsBoolean,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
} from 'class-validator';

import type {
  BillingAdminAddress,
  BillingAdminCreateInvoiceInput,
  BillingAdminInvoiceLineItem,
  BillingAdminTaxInfo,
} from '@platform/event-contracts';

import {
  DiscountAppliesTo,
  DiscountDuration,
  DiscountType,
} from '../entities/discount-code.entity';
import { PricingMetric, TierMultipliers } from '../entities/module-pricing.entity';
import {
  BillingCycle,
  PlanFeatures,
  PlanLimits,
  PlanPricing,
  PlanTier,
  PlanVisibility,
} from '../entities/plan-definition.entity';
import { QuoteRequest } from '../services/pricing-calculator.service';
import type { ModuleQuantities } from '../services/subscription-types';

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
  pricingMetrics?: PricingMetric[];

  @IsOptional()
  @IsObject()
  tierMultipliers?: TierMultipliers;

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
  @IsString()
  @MaxLength(100)
  code!: string;

  @IsUUID('4')
  tenantId!: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  orderAmount?: number;
}

export class ApplyDiscountCodeDto {
  @IsString()
  @MaxLength(100)
  code!: string;

  @IsUUID('4')
  tenantId!: string;

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

  @IsObject()
  template!: Omit<CreateDiscountCodeDto, 'code'>;

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

  @IsString()
  tier!: PlanTier;

  @IsOptional()
  @IsObject()
  quantities?: {
    users?: number;
    farms?: number;
    ponds?: number;
    sensors?: number;
  };
}

export class ComparePricingDto {
  @IsObject()
  config1!: QuoteRequest;

  @IsObject()
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

// ============================================================================
// Plan Definitions (APA-102 / APA-103 / APA-128)
//
// Client-supplied fields only. createdBy / updatedBy are sourced from the JWT
// in the controller (spread in after validation), so they are NOT body fields —
// with forbidNonWhitelisted live, a client-sent createdBy is now rejected 400.
// ============================================================================

export class CreatePlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @IsEnum(PlanTier)
  tier!: PlanTier;

  @IsOptional()
  @IsEnum(PlanVisibility)
  visibility?: PlanVisibility;

  @IsOptional()
  @IsBoolean()
  isRecommended?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsObject()
  limits!: PlanLimits;

  @IsObject()
  pricing!: PlanPricing;

  @IsObject()
  features!: PlanFeatures;

  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  upgradeMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  downgradeWarning?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  badge?: string;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @IsOptional()
  @IsEnum(PlanVisibility)
  visibility?: PlanVisibility;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isRecommended?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  limits?: Partial<PlanLimits>;

  @IsOptional()
  @IsObject()
  pricing?: Partial<PlanPricing>;

  @IsOptional()
  @IsObject()
  features?: Partial<PlanFeatures>;

  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  upgradeMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  downgradeWarning?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  badge?: string;
}

// ============================================================================
// Discount Codes (APA-128) — createdBy / updatedBy from JWT, not body
// ============================================================================

export class CreateDiscountCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsEnum(DiscountType)
  discountType!: DiscountType;

  @IsNumber()
  @Min(0)
  discountValue!: number;

  @IsOptional()
  @IsEnum(DiscountAppliesTo)
  appliesTo?: DiscountAppliesTo;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(1000)
  applicablePlanIds?: string[];

  @IsOptional()
  @IsEnum(DiscountDuration)
  duration?: DiscountDuration;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationInMonths?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validUntil?: Date;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRedemptions?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRedemptionsPerTenant?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumOrderAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  campaignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  campaignName?: string;

  @IsOptional()
  @IsBoolean()
  isReferralCode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referrerId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateDiscountCodeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validUntil?: Date;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRedemptions?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRedemptionsPerTenant?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Module Pricing (APA-128)
// ============================================================================

export class SetModulePricingDto {
  @IsString()
  @IsNotEmpty()
  moduleId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  moduleCode!: string;

  @IsArray()
  pricingMetrics!: PricingMetric[];

  @IsOptional()
  @IsObject()
  tierMultipliers?: TierMultipliers;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveTo?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

// ============================================================================
// Pricing Calculator (APA-118)
// ============================================================================

export class PricingQuoteDto {
  @IsArray()
  modules!: QuoteRequest['modules'];

  @IsEnum(PlanTier)
  tier!: PlanTier;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  discountCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;
}

// ============================================================================
// Subscription plan change (APA-094) — changedBy comes from the JWT, not body
// ============================================================================

export class ChangePlanDto {
  @IsUUID('4')
  tenantId!: string;

  @IsOptional()
  @IsUUID('4')
  currentPlanId?: string;

  @IsUUID('4')
  newPlanId!: string;

  @IsOptional()
  @IsEnum(BillingCycle)
  newBillingCycle?: BillingCycle;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  discountCode?: string;

  @IsOptional()
  @IsBoolean()
  effectiveImmediately?: boolean;
}

// ============================================================================
// Custom Plans (APA-118) — createdBy / updatedBy from JWT, not body
// ============================================================================

export class CreateCustomPlanDto {
  @IsUUID('4')
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID('4')
  basePlanId?: string;

  @IsOptional()
  @IsEnum(PlanTier)
  tier?: PlanTier;

  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @IsArray()
  modules!: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  discountReason?: string;

  @Type(() => Date)
  @IsDate()
  validFrom!: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validTo?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateCustomPlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  discountReason?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validTo?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ============================================================================
// Invoices (APA-094)
// ============================================================================

export class CreateInvoiceDto {
  @IsUUID('4')
  tenantId!: string;

  @IsOptional()
  @IsUUID('4')
  subscriptionId?: string;

  @IsObject()
  billingAddress!: BillingAdminAddress;

  @IsArray()
  lineItems!: BillingAdminInvoiceLineItem[];

  @IsOptional()
  @IsObject()
  tax?: BillingAdminTaxInfo;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  discountCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsISO8601()
  dueDate!: string;

  @IsISO8601()
  periodStart!: string;

  @IsISO8601()
  periodEnd!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ============================================================================
// Payments (APA-094)
// ============================================================================

export class RecordPaymentDto {
  @IsUUID('4')
  invoiceId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  paymentMethod!: string;

  @IsOptional()
  @IsISO8601()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RefundPaymentDto {
  @IsUUID('4')
  paymentId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/**
 * Query DTO for GET /billing/payments (APA-087).
 *
 * The handler previously read every filter as a raw `@Query('x')` string and
 * the service interpolated `invoiceId`/`tenantId` as `$n::uuid`, so any
 * non-UUID value (a partial keystroke, a pasted `INV-…` invoice NUMBER) made
 * Postgres raise 22P02 and surfaced as a 500. Binding the request to a
 * validated DTO turns a malformed id into a 400 at the boundary, never a
 * database error. The operator-facing free-text filter is `search` (matched
 * against invoice_number/transaction_id/notes in the service); `invoiceId` is
 * an exact-UUID deep-link only.
 */
export class ListPaymentsQueryDto {
  @IsOptional()
  @IsUUID('4')
  invoiceId?: string;

  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Comma-separated payment status list (split into a set in the handler). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  status?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
