/**
 * The wire shape of a module price sheet — one shape, whether the row was read
 * or just written (ADR-0013 / BILLING-CRITICAL-002, ADR-0015).
 *
 * Returning the TypeORM entity would publish a lie: `price` and `multiplier`
 * are `Decimal` instances that serialise to a string via `toJSON`, so the
 * generated contract would describe an object where the client receives text.
 * These classes state the JSON, and — being classes in a `.dto.ts` file — the
 * `@nestjs/swagger` plugin can type the responses from them, which an
 * interface cannot do.
 */
import { ApiProperty } from '@nestjs/swagger';
import type {
  BillingCycle,
  BillingDiscountRejectionReason,
  BillingModulePriceSnapshot,
  BillingPlanTier,
  BillingPricingMetricType,
} from '@platform/event-contracts';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

export class ModulePriceMetricDto {
  metricType!: BillingPricingMetricType;
  /** Exact decimal string, in the sheet's currency. */
  price!: string;
  description?: string;
  minQuantity?: number;
  maxQuantity?: number;
  /** Quantity granted before the metric starts charging. */
  includedQuantity?: number;
}

export class ModulePriceTierMultiplierDto {
  tier!: BillingPlanTier;
  /** Exact decimal string in (0, 10]: 1 is full price, 0.9 a 10% tier discount. */
  multiplier!: string;
}

export class ModulePriceResponseDto {
  id!: string;
  moduleId!: string;
  moduleCode!: string;
  currency!: string;
  effectiveFrom!: string;
  effectiveTo?: string;
  isActive!: boolean;
  version!: number;
  notes?: string;
  metrics!: ModulePriceMetricDto[];
  tierMultipliers!: ModulePriceTierMultiplierDto[];
  createdAt!: string;
  updatedAt!: string;
  createdBy?: string;
  updatedBy?: string;
  /** Joined from `auth.modules` — admin's grant, not billing's. */
  moduleName?: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isModuleActive?: boolean;
}

/**
 * The page contract as the swagger plugin can see it (ADMIN-HIGH-004).
 *
 * `@platform/pagination-contracts` owns the shape and is the only place that
 * CONSTRUCTS one — this class never assembles a page, it only restates the
 * field set so `@nestjs/swagger` can type the response. The plugin reads
 * declared property types from a class in a `.dto.ts` file; it can generate
 * nothing from `PaginationResultV1<T>`, a generic alias in a library, which is
 * why every paginated admin route before these was typed `{type: object}` in
 * the artifact. `implements PaginationResultV1<…>` is the compile-time binding:
 * a field added to the authority is an error here, not a silent omission on the
 * wire. Same rationale, and the same declaration exemption, as the GraphQL
 * bridge at `libs/backend-common/src/pagination/pagination.dto.ts`.
 */
export class ModulePricePageDto implements PaginationResultV1<ModulePriceResponseDto> {
  // The plugin infers a property's schema from its declared type and cannot
  // read `readonly T[]`: it falls back to the declaring class and reports a
  // circular dependency. An explicit lazy resolver is the documented way out,
  // and it keeps the `readonly` the authority's type requires.
  @ApiProperty({ type: () => [ModulePriceResponseDto] })
  readonly items!: readonly ModulePriceResponseDto[];
  readonly total!: number;
  readonly page!: number;
  readonly limit!: number;
  readonly totalPages!: number;
  readonly hasNextPage!: boolean;
  readonly hasPreviousPage!: boolean;
}

export class SeedModulePricesResultDto {
  success!: boolean;
  seeded!: number;
}

// ── Quotes ─────────────────────────────────────────────────────────────────

export class ModuleQuoteLineItemDto {
  metric!: BillingPricingMetricType;
  metricLabel!: string;
  quantity!: number;
  includedQuantity!: number;
  billableQuantity!: number;
  /** Exact decimal strings. */
  listUnitPrice!: string;
  unitPrice!: string;
  total!: string;
  tierMultiplier!: string;
}

export class ModuleQuoteBreakdownDto {
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  lineItems!: ModuleQuoteLineItemDto[];
  /** Exact decimal strings. */
  subtotal!: string;
  tierDiscount!: string;
  total!: string;
}

export class ModuleQuoteResponseDto {
  modules!: ModuleQuoteBreakdownDto[];
  /** Exact decimal strings throughout — a quote never crosses as IEEE-754. */
  subtotal!: string;
  tierDiscount!: string;
  cycleDiscountAmount!: string;
  cycleDiscountPercent!: string;
  discountCode?: string;
  discountDescription?: string;
  discountAmount!: string;
  /** Present when a discount code was offered and refused. */
  discountReason?: BillingDiscountRejectionReason;
  /** What a negotiated (hand-entered) discount took off, if one was quoted. */
  negotiatedDiscountAmount!: string;
  tax!: string;
  taxRate!: string;
  total!: string;
  monthlyTotal!: string;
  annualTotal!: string;
  billingCycle!: BillingCycle;
  billingCycleMultiplier!: number;
  currency!: string;
  tier!: BillingPlanTier;
  calculatedAt!: string;
  /**
   * Modules the operator selected that have no active price sheet. Not an
   * error — a free/core module legitimately has none — but a quote that
   * silently omits a selected module is a lie, so it says which.
   */
  unpricedModuleCodes!: string[];
}

export class ModuleQuoteComparisonDto {
  config1!: ModuleQuoteResponseDto;
  config2!: ModuleQuoteResponseDto;
  /** Exact decimal strings. */
  monthlyDifference!: string;
  percentDifference!: string;
  recommendation!: string;
}

export class QuickEstimateResponseDto {
  /** Exact decimal strings. */
  monthlyTotal!: string;
  annualTotal!: string;
  currency!: string;
  unpricedModuleCodes!: string[];
}

/**
 * Compile-time proof that every field this response publishes exists on
 * billing's snapshot; a rename or a drop in billing fails the build here
 * rather than surfacing as an `undefined` on the ModulePricing page.
 */
type MissingName<TResponse, TSnapshot> = Exclude<keyof TResponse, keyof TSnapshot>;
export const MODULE_PRICE_RESPONSE_COVERED: MissingName<
  Omit<
    ModulePriceResponseDto,
    'moduleName' | 'moduleDescription' | 'moduleIcon' | 'isModuleActive'
  >,
  BillingModulePriceSnapshot
> extends never
  ? true
  : MissingName<
      Omit<
        ModulePriceResponseDto,
        'moduleName' | 'moduleDescription' | 'moduleIcon' | 'isModuleActive'
      >,
      BillingModulePriceSnapshot
    > = true;
