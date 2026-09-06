/**
 * The wire shape of a discount code — one shape, whether the row was read or
 * just written (ADR-0013 / BILLING-CRITICAL-002, ADR-0015).
 *
 * Reads come from the read-only mapping of `billing.discount_codes`; writes
 * come back as a `BillingDiscountCodeSnapshot` from billing's command reply.
 * Returning the TypeORM entity directly would publish a lie: `percentOff` and
 * `amountOff` are `Decimal` instances that serialise to a string via
 * `toJSON`, so the generated contract would describe an object where the
 * client receives text. These classes state the JSON, and — being classes in
 * a `.dto.ts` file — the `@nestjs/swagger` plugin can type the responses from
 * them, which an interface cannot do.
 *
 * `assertContractRenders` below is the compile-time link: if billing's
 * snapshot loses a field these classes require, the build fails here rather
 * than the admin panel rendering `undefined`.
 */
import type {
  BillingDiscountAppliesTo,
  BillingDiscountCodeSnapshot,
  BillingDiscountDuration,
  BillingDiscountRedemptionSnapshot,
  BillingDiscountRejectionReason,
  BillingDiscountType,
} from '@platform/event-contracts';

export class DiscountCodeResponseDto {
  id!: string;
  code!: string;
  name!: string;
  description?: string;
  discountType!: BillingDiscountType;
  /** Exact decimal string; set for `percentage` only. */
  percentOff?: string;
  /** Exact decimal string in `currency`; set for `fixed_amount` only. */
  amountOff?: string;
  /** Set for `free_months` only. */
  freeMonths?: number;
  /** Set for `free_trial_extension` only. */
  trialExtensionDays?: number;
  currency!: string;
  appliesTo!: BillingDiscountAppliesTo;
  applicablePlanIds?: string[];
  duration!: BillingDiscountDuration;
  durationInMonths?: number;
  isActive!: boolean;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  currentRedemptions!: number;
  maxRedemptionsPerTenant?: number;
  /** Exact decimal string. */
  minimumOrderAmount?: string;
  campaignId?: string;
  campaignName?: string;
  stripePromotionCodeId?: string;
  stripeCouponId?: string;
  isReferralCode!: boolean;
  referrerId?: string;
  metadata?: Record<string, unknown>;
  createdAt!: string;
  updatedAt!: string;
  createdBy?: string;
  updatedBy?: string;
}

export class DiscountRedemptionResponseDto {
  id!: string;
  discountCodeId!: string;
  tenantId!: string;
  subscriptionId?: string;
  invoiceId?: string;
  /** Exact decimal string. */
  discountAmount!: string;
  currency!: string;
  redeemedAt!: string;
  redeemedBy?: string;
}

export class DiscountCodePageDto {
  data!: DiscountCodeResponseDto[];
  total!: number;
  page!: number;
  limit!: number;
}

export class DiscountRedemptionPageDto {
  data!: DiscountRedemptionResponseDto[];
  total!: number;
  page!: number;
  limit!: number;
}

export class DiscountTopCodeDto {
  code!: string;
  redemptions!: number;
  /** Exact decimal string — a sum of money never widens through a double. */
  totalDiscount!: string;
}

export class DiscountStatsDto {
  totalCodes!: number;
  activeCodes!: number;
  expiredCodes!: number;
  totalRedemptions!: number;
  /** Exact decimal string. */
  totalDiscountAmount!: string;
  topCodes!: DiscountTopCodeDto[];
}

export class DiscountCodeLookupDto {
  found!: boolean;
  discount?: DiscountCodeResponseDto;
}

export class DiscountValidationResponseDto {
  valid!: boolean;
  /** Why it was refused; absent when valid. */
  reason?: BillingDiscountRejectionReason;
  message?: string;
  /**
   * Exact decimal string. Absent when no order amount was supplied, and when
   * the code grants a free period rather than taking money off — which is not
   * the same as `'0'`.
   */
  discountAmount?: string;
  discountCode?: DiscountCodeResponseDto;
}

export class DiscountApplicationResponseDto {
  /** False when a rule refused the code — the order simply is not discounted. */
  valid!: boolean;
  reason?: BillingDiscountRejectionReason;
  /** Exact decimal strings. */
  originalAmount!: string;
  discountAmount!: string;
  finalAmount!: string;
  grantedFreeMonths?: number;
  grantedTrialExtensionDays?: number;
  redemptionId?: string;
  message?: string;
}

export class GeneratedDiscountCodeDto {
  code!: string;
}

export class BulkCreatedDiscountCodesDto {
  success!: boolean;
  count!: number;
  codes!: DiscountCodeResponseDto[];
}

/**
 * Compile-time proof that every field these response classes publish exists on
 * billing's snapshot. If billing renames or drops one, the constant below
 * stops being assignable to `true` and the build fails here — the admin panel
 * never discovers it as an `undefined` on screen.
 *
 * Nullability is deliberately NOT asserted: the mappers in
 * `discount-code.service.ts` normalise billing's `| null` to `undefined`, so
 * requiring identical types would only re-state the mapper. Names are what
 * drift silently.
 */
type MissingName<TResponse, TSnapshot> = Exclude<keyof TResponse, keyof TSnapshot>;

/** The four value fields; only one is present per branch, so `keyof` a union omits them. */
type DiscountValueField = 'percentOff' | 'amountOff' | 'freeMonths' | 'trialExtensionDays';

export const DISCOUNT_CODE_RESPONSE_COVERED: MissingName<
  Omit<DiscountCodeResponseDto, DiscountValueField>,
  BillingDiscountCodeSnapshot
> extends never
  ? true
  : MissingName<Omit<DiscountCodeResponseDto, DiscountValueField>, BillingDiscountCodeSnapshot> =
  true;

export const DISCOUNT_REDEMPTION_RESPONSE_COVERED: MissingName<
  DiscountRedemptionResponseDto,
  BillingDiscountRedemptionSnapshot
> extends never
  ? true
  : MissingName<DiscountRedemptionResponseDto, BillingDiscountRedemptionSnapshot> = true;
