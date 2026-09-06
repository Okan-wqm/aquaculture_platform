/**
 * The wire shape of a plan — one shape, whether the row was read or just
 * written (ADR-0013 / BILLING-CRITICAL-002, ADR-0015).
 *
 * Returning the TypeORM entity would publish a lie: prices and the cycle
 * discount are `Decimal` instances that serialise to strings via `toJSON`, so
 * the generated contract would describe objects where the client receives
 * text. These classes state the JSON, and — being classes in a `.dto.ts` file
 * — the `@nestjs/swagger` plugin can type the responses from them.
 */
import type {
  BillingCycle,
  BillingPlanSnapshot,
  BillingPlanTier,
  BillingPlanVisibility,
} from '@platform/event-contracts';

export class PlanLimitsResponseDto {
  /** `-1` means unlimited, the convention `PLAN_CATALOG` uses (ADR-037). */
  maxUsers!: number;
  maxFarms!: number;
  maxPonds!: number;
  maxSensors!: number;
  maxModules!: number;
  storageGB!: number;
  dataRetentionDays!: number;
  apiRateLimit!: number;
  alertsEnabled!: boolean;
  reportsEnabled!: boolean;
  customBrandingEnabled!: boolean;
  apiAccessEnabled!: boolean;
  customIntegrationsEnabled!: boolean;
  ssoEnabled!: boolean;
  auditLogEnabled!: boolean;
  prioritySupport!: boolean;
  dedicatedAccountManager!: boolean;
}

export class PlanFeaturesResponseDto {
  coreFeatures!: string[];
  advancedFeatures!: string[];
  premiumFeatures!: string[];
}

export class PlanCyclePriceResponseDto {
  billingCycle!: BillingCycle;
  /** Exact decimal strings, in the plan's currency. */
  basePrice!: string;
  perUserPrice!: string;
  perFarmPrice!: string;
  perModulePrice!: string;
  /** Exact decimal string in [0, 100] — the commitment discount for this cycle. */
  discountPercent!: string;
}

export class PlanAddOnResponseDto {
  code!: string;
  name!: string;
  description?: string;
  /** Exact decimal string. */
  price!: string;
  billingCycle!: BillingCycle;
}

export class PlanResponseDto {
  id!: string;
  code?: string;
  name!: string;
  description?: string;
  shortDescription?: string;
  tier!: BillingPlanTier;
  currency!: string;
  defaultBillingCycle!: BillingCycle;
  visibility!: BillingPlanVisibility;
  isActive!: boolean;
  isRecommended!: boolean;
  sortOrder!: number;
  limits!: PlanLimitsResponseDto;
  features!: PlanFeaturesResponseDto;
  cyclePrices!: PlanCyclePriceResponseDto[];
  addOns!: PlanAddOnResponseDto[];
  trialDays?: number;
  gracePeriodDays?: number;
  upgradeMessage?: string;
  downgradeWarning?: string;
  icon?: string;
  color?: string;
  badge?: string;
  /** Read-only here: `billing.plans` is the one writable home (ADR-0013). */
  stripeProductId?: string;
  stripePriceIds?: Record<string, string>;
  version!: number;
  createdAt!: string;
  updatedAt!: string;
  createdBy?: string;
  updatedBy?: string;
}

export class PlanLookupDto {
  found!: boolean;
  plan?: PlanResponseDto;
}

export class PlanLimitChangeDto {
  limit!: string;
  currentValue!: number;
  newValue!: number;
  change!: 'increase' | 'decrease' | 'same';
}

export class PlanFeatureChangeDto {
  feature!: string;
  gaining!: boolean;
}

/** What changes between two plans. Prices are exact decimal strings. */
export class PlanComparisonResponseDto {
  isUpgrade!: boolean;
  isDowngrade!: boolean;
  /** The new plan's monthly price minus the current one's; may be negative. */
  priceDifference!: string;
  limitChanges!: PlanLimitChangeDto[];
  featureChanges!: PlanFeatureChangeDto[];
  warnings!: string[];
}

/** A mid-cycle change, pro-rated by the days remaining. Exact decimal strings. */
export class ProratedPricingResponseDto {
  currentPlanCredit!: string;
  newPlanCost!: string;
  /** Positive = the customer pays, negative = they are credited. */
  proratedAmount!: string;
  daysRemaining!: number;
  /** ISO-8601. */
  effectiveDate!: string;
}

/**
 * Compile-time proof that every field this response publishes exists on
 * billing's snapshot; a rename or a drop in billing fails the build here
 * rather than surfacing as an `undefined` on the PlanManagement page.
 */
type MissingName<TResponse, TSnapshot> = Exclude<keyof TResponse, keyof TSnapshot>;
export const PLAN_RESPONSE_COVERED: MissingName<PlanResponseDto, BillingPlanSnapshot> extends never
  ? true
  : MissingName<PlanResponseDto, BillingPlanSnapshot> = true;
