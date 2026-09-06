/**
 * Discount catalogue — billing owns the rows (ADR-0013, BILLING-CRITICAL-002).
 *
 * These tables moved out of `admin` because a discount is a price: it decides
 * what a subscription and an invoice are worth, and billing is the sole writer
 * of those (D14). admin-api keeps authoring them, but through the
 * `request.billing.admin.*Discount*` commands, and reads them back through a
 * read-only mapping of these same tables.
 *
 * The value model is a discriminated set of columns rather than the single
 * `discount_value numeric(10,2)` the admin table used. That column held a
 * percentage for one row and an amount of money for the next, so no CHECK
 * could constrain it — `150` was a legal 150% and a legal $150 at once — and
 * the two non-monetary kinds (`free_months`, `free_trial_extension`) had
 * nowhere to put their number, so the calculator silently returned a discount
 * of zero for them. One column per kind makes the constraint expressible
 * (`percent_off <= 100`), makes the currency of an amount explicit, and makes
 * the calculation total.
 */
import { MoneyColumn, PercentColumn } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED_AMOUNT = 'fixed_amount',
  FREE_TRIAL_EXTENSION = 'free_trial_extension',
  FREE_MONTHS = 'free_months',
}

export enum DiscountAppliesTo {
  ALL_PLANS = 'all_plans',
  SPECIFIC_PLANS = 'specific_plans',
  UPGRADES_ONLY = 'upgrades_only',
  NEW_SUBSCRIPTIONS_ONLY = 'new_subscriptions_only',
}

export enum DiscountDuration {
  ONCE = 'once',
  REPEATING = 'repeating',
  FOREVER = 'forever',
}

/**
 * A percentage is not money: it is a rate in (0, 100] with two decimals, and
 * `numeric(5,2)` is the widest column that cannot hold a nonsense rate.
 * `MoneyColumn`'s `numeric(19,4)` would accept 4 000 000 000 000 00.0000%.
 */
@Entity('discount_codes', { schema: 'billing' })
@Index(['code'], { unique: true })
@Index(['isActive'])
@Index(['validFrom', 'validUntil'])
@Index(['campaignId'])
export class DiscountCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Normalised to upper-case A–Z0–9 before insert; the DB CHECK re-asserts it. */
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'enum', enum: DiscountType, name: 'discount_type' })
  discountType!: DiscountType;

  /** `percentage` only. */
  @PercentColumn({ name: 'percent_off', nullable: true })
  percentOff!: Decimal | null;

  /** `fixed_amount` only, denominated in `currency`. */
  @MoneyColumn({ name: 'amount_off', nullable: true })
  amountOff!: Decimal | null;

  /** `free_months` only. */
  @Column({ type: 'int', nullable: true, name: 'free_months' })
  freeMonths!: number | null;

  /** `free_trial_extension` only. */
  @Column({ type: 'int', nullable: true, name: 'trial_extension_days' })
  trialExtensionDays!: number | null;

  /** ISO-4217, upper-case. Denominates `amountOff` and `minimumOrderAmount`. */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({
    type: 'enum',
    enum: DiscountAppliesTo,
    name: 'applies_to',
    default: DiscountAppliesTo.ALL_PLANS,
  })
  appliesTo!: DiscountAppliesTo;

  @Column({ type: 'jsonb', nullable: true, name: 'applicable_plan_ids' })
  applicablePlanIds?: string[] | null;

  @Column({ type: 'enum', enum: DiscountDuration, default: DiscountDuration.ONCE })
  duration!: DiscountDuration;

  @Column({ type: 'int', nullable: true, name: 'duration_in_months' })
  durationInMonths?: number | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'valid_from' })
  validFrom?: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'valid_until' })
  validUntil?: Date | null;

  @Column({ type: 'int', nullable: true, name: 'max_redemptions' })
  maxRedemptions?: number | null;

  /**
   * Advanced only by the conditional claim UPDATE in `DiscountCodeService`,
   * never by a read-modify-write: two concurrent redemptions of the last
   * remaining use must not both succeed. The DB CHECK
   * `current_redemptions <= max_redemptions` is the backstop.
   */
  @Column({ type: 'int', default: 0, name: 'current_redemptions' })
  currentRedemptions!: number;

  @Column({ type: 'int', nullable: true, name: 'max_redemptions_per_tenant' })
  maxRedemptionsPerTenant?: number | null;

  @MoneyColumn({ name: 'minimum_order_amount', nullable: true })
  minimumOrderAmount!: Decimal | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'campaign_id' })
  campaignId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'campaign_name' })
  campaignName?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_promotion_code_id' })
  stripePromotionCodeId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_coupon_id' })
  stripeCouponId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false, name: 'is_referral_code' })
  isReferralCode!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'referrer_id' })
  referrerId?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'created_by' })
  createdBy?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'updated_by' })
  updatedBy?: string | null;
}

/**
 * One redemption of one code by one tenant. Tenant-scoped, so RLS applies and
 * the GDPR erasure cascade reaches it by `tenant_id`.
 */
@Entity('discount_redemptions', { schema: 'billing' })
@Index(['discountCodeId'])
@Index(['tenantId'])
@Index(['redeemedAt'])
export class DiscountRedemption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'discount_code_id' })
  discountCodeId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'subscription_id' })
  subscriptionId?: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'invoice_id' })
  invoiceId?: string | null;

  /** What this redemption actually took off, in `currency`. Zero for the free-period kinds. */
  @MoneyColumn({ name: 'discount_amount' })
  discountAmount!: Decimal;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'redeemed_at', default: () => 'now()' })
  redeemedAt!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'redeemed_by' })
  redeemedBy?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
