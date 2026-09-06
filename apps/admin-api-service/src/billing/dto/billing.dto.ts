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
import {
  BILLING_CYCLES,
  BILLING_PLAN_VISIBILITIES,
  BILLING_PRICING_METRIC_TYPES,
  BillingPlanTier,
} from '@platform/event-contracts';
import type {
  BillingCycle,
  BillingDiscountAppliesTo,
  BillingDiscountDuration,
  BillingDiscountSubscriptionChange,
  BillingDiscountType,
  BillingPlanVisibility,
  BillingPricingMetricType,
} from '@platform/event-contracts';

/**
 * An exact decimal string. Money and rates cross the admin boundary as text
 * for the same reason they do on the NATS wire: '12.50' is the same value on
 * both sides, 12.5 is not necessarily (ADR-0013).
 */
const MONEY_STRING = /^\d{1,13}(\.\d{1,4})?$/;
/** A percentage in [0, 100] with up to two decimals — the range the DB CHECKs. */
const PERCENT_STRING = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;
/** A tier multiplier: (0, 10] with up to four decimals. */
const MULTIPLIER_STRING = /^(10(\.0{1,4})?|\d(\.\d{1,4})?)$/;
/** A calendar day. A plan's validity window is a day, never an instant. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * What a plan costs on ONE billing cycle (ADR-0013). One object per cycle the
 * plan is actually sold on, replacing the fixed four-key `pricing` matrix that
 * forced every plan to price all four cycles and hid its money inside jsonb.
 * Prices are exact decimal strings for the same reason they are `numeric(19,4)`
 * in `billing.plan_cycle_prices`.
 */
export class PlanCyclePriceDto {
  @IsIn(BILLING_CYCLES) billingCycle!: BillingCycle;
  @Matches(MONEY_STRING, { message: 'basePrice must be a decimal string' }) basePrice!: string;
  @Matches(MONEY_STRING, { message: 'perUserPrice must be a decimal string' })
  perUserPrice!: string;
  @Matches(MONEY_STRING, { message: 'perFarmPrice must be a decimal string' })
  perFarmPrice!: string;
  @Matches(MONEY_STRING, { message: 'perModulePrice must be a decimal string' })
  perModulePrice!: string;
  @Matches(PERCENT_STRING, { message: 'discountPercent must be a decimal string in [0, 100]' })
  discountPercent!: string;
}

/** A priced extra. It is a row in `billing.plan_add_ons`, not a feature string. */
export class PlanAddOnDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @Matches(MONEY_STRING, { message: 'price must be a decimal string' }) price!: string;
  @IsIn(BILLING_CYCLES) billingCycle!: BillingCycle;
}

/**
 * The named feature sets a plan advertises. Add-ons used to live in here; they
 * carry a price, so they are their own rows and their own request field —
 * money two levels inside a features blob is money no CHECK can reach.
 */
export class PlanFeaturesDto {
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) coreFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) advancedFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) premiumFeatures!: string[];
}

/** Stripe price id per billing cycle. Keys ARE the `BillingCycle` values. */
export class StripePriceIdsDto {
  @IsOptional() @IsString() @MaxLength(255) monthly?: string;
  @IsOptional() @IsString() @MaxLength(255) quarterly?: string;
  @IsOptional() @IsString() @MaxLength(255) semi_annual?: string;
  @IsOptional() @IsString() @MaxLength(255) annual?: string;
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
  @IsOptional() @IsString() @MaxLength(100) code?: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsEnum(BillingPlanTier) tier!: BillingPlanTier;
  /** ISO-4217, upper-case. Denominates every price on the plan. */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  /** The cycle a subscription defaults to when the caller names none. */
  @IsOptional() @IsIn(BILLING_CYCLES) defaultBillingCycle?: BillingCycle;
  @IsOptional() @IsIn(BILLING_PLAN_VISIBILITIES) visibility?: BillingPlanVisibility;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @ValidateNested() @Type(() => PlanLimitsDto) limits!: PlanLimitsDto;
  @IsOptional() @ValidateNested() @Type(() => PlanFeaturesDto) features?: PlanFeaturesDto;
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PlanCyclePriceDto)
  cyclePrices!: PlanCyclePriceDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlanAddOnDto)
  addOns?: PlanAddOnDto[];
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(1000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
  /** `billing.plans` is the ONE writable home for the Stripe catalogue ids. */
  @IsOptional() @IsString() @MaxLength(255) stripeProductId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => StripePriceIdsDto)
  stripePriceIds?: StripePriceIdsDto;
}

/** An update may send a subset of a nested object, so the nested shapes are partial. */
export class PartialPlanLimitsDto extends PartialType(PlanLimitsDto) {}
export class PartialPlanFeaturesDto extends PartialType(PlanFeaturesDto) {}

/**
 * `cyclePrices` and `addOns` are NOT partial: each is the complete set for the
 * plan. Sending half a price row would leave the other half at whatever the DB
 * default is, which for money is a silent 0.
 */
export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(100) code?: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsEnum(BillingPlanTier) tier?: BillingPlanTier;
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  @IsOptional() @IsIn(BILLING_CYCLES) defaultBillingCycle?: BillingCycle;
  @IsOptional() @IsIn(BILLING_PLAN_VISIBILITIES) visibility?: BillingPlanVisibility;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => PartialPlanLimitsDto) limits?: PartialPlanLimitsDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => PartialPlanFeaturesDto)
  features?: PartialPlanFeaturesDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PlanCyclePriceDto)
  cyclePrices?: PlanCyclePriceDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlanAddOnDto)
  addOns?: PlanAddOnDto[];
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(1000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
  @IsOptional() @IsString() @MaxLength(255) stripeProductId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => StripePriceIdsDto)
  stripePriceIds?: StripePriceIdsDto;
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
  @IsEnum(BillingPlanTier) tier!: BillingPlanTier;
  @IsIn(BILLING_CYCLES) billingCycle!: BillingCycle;
  @IsOptional() @IsString() @MaxLength(64) discountCode?: string;
  /** Exact decimal string percentage, 0-100. */
  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'taxRate must be a decimal string' })
  taxRate?: string;
  /**
   * A negotiated discount the operator is entering by hand (ADR-0013). The
   * custom-plan builder quotes with these so the total it previews is the one
   * billing will store — it used to recompute that total in the browser, in
   * floats, and its annual figure took the fixed discount off twelve times.
   */
  @IsOptional()
  @Matches(PERCENT_STRING, {
    message: 'negotiatedDiscountPercent must be a decimal string in [0, 100]',
  })
  negotiatedDiscountPercent?: string;
  @IsOptional()
  @Matches(MONEY_STRING, { message: 'negotiatedDiscountAmount must be a decimal string' })
  negotiatedDiscountAmount?: string;
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
  @IsOptional() @IsIn(BILLING_CYCLES) newBillingCycle?: BillingCycle;
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
  @IsOptional() @IsEnum(BillingPlanTier) tier?: BillingPlanTier;
  @IsOptional() @IsIn(BILLING_CYCLES) billingCycle?: BillingCycle;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomPlanModuleDto)
  modules!: CustomPlanModuleDto[];
  // ADR-0013: money and rates cross the boundary as exact decimal strings.
  // `discountPercent` was an unbounded `number` on a `numeric(5,2)` column, so
  // a 400% discount was storable and floored the plan's total to zero rather
  // than being refused.
  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'discountPercent must be a decimal string in [0, 100]' })
  discountPercent?: string;
  @IsOptional()
  @Matches(MONEY_STRING, { message: 'discountAmount must be a decimal string' })
  discountAmount?: string;
  @IsOptional() @IsString() @MaxLength(500) discountReason?: string;
  /** ISO-4217, upper-case. Defaults to the price sheet's own currency. */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  /** ISO-8601 dates: a plan's validity is a day, never an instant. */
  @Matches(ISO_DATE, { message: 'validFrom must be an ISO-8601 date (YYYY-MM-DD)' })
  validFrom!: string;
  @IsOptional()
  @Matches(ISO_DATE, { message: 'validTo must be an ISO-8601 date (YYYY-MM-DD)' })
  validTo?: string;
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
  @IsOptional() @IsIn(BILLING_CYCLES) billingCycle?: BillingCycle;
  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'discountPercent must be a decimal string in [0, 100]' })
  discountPercent?: string;
  @IsOptional()
  @Matches(MONEY_STRING, { message: 'discountAmount must be a decimal string' })
  discountAmount?: string;
  @IsOptional() @IsString() @MaxLength(500) discountReason?: string;
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  @IsOptional()
  @Matches(ISO_DATE, { message: 'validFrom must be an ISO-8601 date (YYYY-MM-DD)' })
  validFrom?: string;
  @IsOptional()
  @Matches(ISO_DATE, { message: 'validTo must be an ISO-8601 date (YYYY-MM-DD)' })
  validTo?: string;
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

  @IsEnum(BillingPlanTier)
  tier!: BillingPlanTier;

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
