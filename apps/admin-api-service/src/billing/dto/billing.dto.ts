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
  IsIn,
  Matches,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { BILLING_PRICING_METRIC_TYPES } from '@platform/event-contracts';
import type {
  BillingDiscountAppliesTo,
  BillingDiscountDuration,
  BillingDiscountSubscriptionChange,
  BillingDiscountType,
  BillingPricingMetricType,
} from '@platform/event-contracts';

import { BillingCycle, PlanTier, PlanVisibility } from '../entities/plan-definition.entity';

/**
 * An exact decimal string. Money and rates cross the admin boundary as text
 * for the same reason they do on the NATS wire: '12.50' is the same value on
 * both sides, 12.5 is not necessarily (ADR-0013).
 */
const MONEY_STRING = /^\d{1,13}(\.\d{1,4})?$/;
const PERCENT_STRING = /^\d{1,3}(\.\d{1,2})?$/;
/** A tier multiplier: (0, 10] with up to four decimals. */
const MULTIPLIER_STRING = /^(10(\.0{1,4})?|\d(\.\d{1,4})?)$/;

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

/**
 * One metric on a module price sheet (ADR-0013). `price` is an exact decimal
 * STRING, and the currency belongs to the sheet, not to each metric — a sheet
 * with a per-user price in EUR and a per-sensor price in USD could not be
 * summed, and the old per-metric `currency` made that representable.
 */
export class PricingMetricDto {
  @IsIn(BILLING_PRICING_METRIC_TYPES) metricType!: BillingPricingMetricType;
  @Matches(MONEY_STRING, { message: 'price must be a decimal string' }) price!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) minQuantity?: number;
  @IsOptional() @IsInt() @Min(0) maxQuantity?: number;
  @IsOptional() @IsInt() @Min(0) includedQuantity?: number;
}

/**
 * Multipliers keyed by tier. The property names ARE the `PlanTier` values, so
 * this class is structurally the `TierMultipliers` index the entity declares.
 */
/**
 * A tier's price multiplier as an exact decimal string in (0, 10]: 1 is full
 * price, 0.9 a 10% tier discount. The bound is the same one
 * `billing.module_price_tier_multipliers` CHECKs — 0 would make a metric free
 * by accident rather than by an explicit price of 0.
 */
export class TierMultipliersDto {
  @IsOptional() @Matches(MULTIPLIER_STRING) free?: string;
  @IsOptional() @Matches(MULTIPLIER_STRING) starter?: string;
  @IsOptional() @Matches(MULTIPLIER_STRING) professional?: string;
  @IsOptional() @Matches(MULTIPLIER_STRING) enterprise?: string;
  @IsOptional() @Matches(MULTIPLIER_STRING) custom?: string;
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

const DISCOUNT_TYPES: readonly BillingDiscountType[] = [
  'percentage',
  'fixed_amount',
  'free_months',
  'free_trial_extension',
];
const DISCOUNT_APPLIES_TO: readonly BillingDiscountAppliesTo[] = [
  'all_plans',
  'specific_plans',
  'upgrades_only',
  'new_subscriptions_only',
];
const DISCOUNT_DURATIONS: readonly BillingDiscountDuration[] = ['once', 'repeating', 'forever'];
const SUBSCRIPTION_CHANGES: readonly BillingDiscountSubscriptionChange[] = [
  'new',
  'upgrade',
  'other',
];

/** Which field carries the value, per kind — the same split billing's CHECK enforces. */
const VALUE_FIELD_BY_TYPE: Readonly<Record<BillingDiscountType, string>> = {
  percentage: 'percentOff',
  fixed_amount: 'amountOff',
  free_months: 'freeMonths',
  free_trial_extension: 'trialExtensionDays',
};

/**
 * Exactly one value field, and it must be the one the kind names.
 *
 * `@ValidateIf` cannot express this per-property: two conditions on one
 * property are ANDed, so "required for my kind AND forbidden for the others"
 * has to be asked once, over the whole object.
 */
@ValidatorConstraint({ name: 'discountValueBranch', async: false })
class DiscountValueBranchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const object = args.object as Record<string, unknown>;
    const kind = object['discountType'];
    if (typeof kind !== 'string' || !(kind in VALUE_FIELD_BY_TYPE)) return false;
    const expected = VALUE_FIELD_BY_TYPE[kind as BillingDiscountType];
    if (object[expected] === undefined || object[expected] === null) return false;
    return Object.entries(VALUE_FIELD_BY_TYPE)
      .filter(([type]) => type !== kind)
      .every(([, field]) => object[field] === undefined || object[field] === null);
  }

  defaultMessage(args: ValidationArguments): string {
    const kind = (args.object as Record<string, unknown>)['discountType'];
    const expected =
      typeof kind === 'string' && kind in VALUE_FIELD_BY_TYPE
        ? VALUE_FIELD_BY_TYPE[kind as BillingDiscountType]
        : null;
    return expected
      ? `a ${String(kind)} discount must set ${expected} and no other value field`
      : `discountType must be one of ${DISCOUNT_TYPES.join(', ')}`;
  }
}

function DiscountValueBranch(options?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'discountValueBranch',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: DiscountValueBranchConstraint,
    });
  };
}

/** Everything a discount code carries except its code — the bulk-create template. */
export class DiscountCodeTemplateDto {
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsIn(DISCOUNT_TYPES)
  @DiscountValueBranch()
  discountType!: BillingDiscountType;

  // ── The value, by kind. `billing.discount_codes` holds these same four
  // columns under one CHECK; the previous single `discountValue` could not be
  // constrained because 150 was a legal 150% and a legal $150 at once.
  @ValidateIf((o: DiscountCodeTemplateDto) => o.discountType === 'percentage')
  @Matches(PERCENT_STRING, { message: 'percentOff must be a decimal string with up to 2 places' })
  percentOff?: string;

  @ValidateIf((o: DiscountCodeTemplateDto) => o.discountType === 'fixed_amount')
  @Matches(MONEY_STRING, { message: 'amountOff must be a decimal string with up to 4 places' })
  amountOff?: string;

  @ValidateIf((o: DiscountCodeTemplateDto) => o.discountType === 'free_months')
  @IsInt()
  @Min(1)
  @Max(120)
  freeMonths?: number;

  @ValidateIf((o: DiscountCodeTemplateDto) => o.discountType === 'free_trial_extension')
  @IsInt()
  @Min(1)
  @Max(3650)
  trialExtensionDays?: number;

  /** ISO-4217, upper-case. Denominates amountOff and minimumOrderAmount. */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;

  @IsOptional() @IsIn(DISCOUNT_APPLIES_TO) appliesTo?: BillingDiscountAppliesTo;
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(200)
  applicablePlanIds?: string[];
  @IsOptional() @IsIn(DISCOUNT_DURATIONS) duration?: BillingDiscountDuration;
  @IsOptional() @IsInt() @Min(1) @Max(120) durationInMonths?: number;
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional()
  @Matches(MONEY_STRING, { message: 'minimumOrderAmount must be a decimal string' })
  minimumOrderAmount?: string;
  @IsOptional() @IsString() @MaxLength(100) campaignId?: string;
  @IsOptional() @IsString() @MaxLength(255) campaignName?: string;
  @IsOptional() @IsBoolean() isReferralCode?: boolean;
  @IsOptional() @IsUUID('4') referrerId?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class CreateDiscountCodeDto extends DiscountCodeTemplateDto {
  @Matches(/^[A-Za-z0-9_-]{3,64}$/, {
    message: 'code must be 3-64 characters of letters, digits, _ or -',
  })
  code!: string;
}

/**
 * The mutable half. The value branch, the code and the campaign are absent on
 * purpose: a code already handed to a customer that silently changes what it
 * is worth is a repudiation risk, so a different offer is a different code.
 *
 * Absent is the enforcement, not an omission — `forbidNonWhitelisted: true`
 * (the global ValidationPipe) refuses a body carrying `discountType`,
 * `percentOff`, `amountOff` or `code` with 400 rather than ignoring them.
 */
export class UpdateDiscountCodeDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

// ============================================================================
// Module pricing + quotes
// ============================================================================

/**
 * Publish a price sheet for a module. Every publish opens a NEW effective
 * window and closes the previous one — a price is never edited in place, so an
 * invoice can always be read back against the prices that produced it.
 */
export class SetModulePricingDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(50) moduleCode!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PricingMetricDto)
  pricingMetrics!: PricingMetricDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => TierMultipliersDto)
  tierMultipliers?: TierMultipliersDto;
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsISO8601() effectiveTo?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class QuoteRequest {
  /**
   * ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives
   * through @TenantParam('body'). Required only when `discountCode` is set —
   * a discount is quoted for a tenant or not at all (ADR-0013).
   */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ModuleSelectionDto)
  modules!: ModuleSelectionDto[];
  @IsEnum(PlanTier) tier!: PlanTier;
  @IsEnum(BillingCycle) billingCycle!: BillingCycle;
  @IsOptional() @IsString() @MaxLength(64) discountCode?: string;
  /** Exact decimal string percentage, 0-100. */
  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'taxRate must be a decimal string' })
  taxRate?: string;
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

/**
 * Republish a sheet with changes. Anything omitted keeps the value the sheet
 * in force already carries; the result is still a NEW window, never an edit.
 */
export class UpdateModulePricingDto {
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
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;

  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * Seed the default sheet for the named module codes. The code → id mapping is
 * resolved server-side from `auth.modules` — admin's grant — rather than
 * supplied by the client, which could otherwise point a module's prices at
 * another module's id.
 */
export class SeedModulePricingDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  moduleCodes!: string[];
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

  /**
   * What the redemption is for. An `upgrades_only` / `new_subscriptions_only`
   * code cannot be decided without it, and billing refuses one rather than
   * assuming — the two restrictions used to permit everything.
   */
  @IsOptional()
  @IsIn(SUBSCRIPTION_CHANGES)
  subscriptionChange?: BillingDiscountSubscriptionChange;

  @IsOptional()
  @Matches(MONEY_STRING, { message: 'orderAmount must be a decimal string' })
  orderAmount?: string;
}

export class ApplyDiscountCodeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @Matches(MONEY_STRING, { message: 'orderAmount must be a decimal string' })
  orderAmount!: string;

  @IsOptional()
  @IsUUID('4')
  subscriptionId?: string;

  @IsOptional()
  @IsUUID('4')
  invoiceId?: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;

  /** See ValidateDiscountCodeDto.subscriptionChange. */
  @IsOptional()
  @IsIn(SUBSCRIPTION_CHANGES)
  subscriptionChange?: BillingDiscountSubscriptionChange;
}

export class GenerateDiscountCodeDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_]{1,20}$/, { message: 'prefix must be letters, digits or _' })
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(32)
  length?: number;
}

export class BulkCreateDiscountCodesDto {
  // 500 is billing's own ceiling — the codes are minted one at a time so each
  // gets its own uniqueness check, and a larger batch would hold the command
  // open past the NATS request timeout.
  @IsInt()
  @Min(1)
  @Max(500)
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
  /** ADMIN-CRITICAL-009: whitelisted carrier key; see QuoteRequest.tenantId. */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

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
