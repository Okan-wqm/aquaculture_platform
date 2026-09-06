/**
 * Read-only mapping of the discount catalogue billing owns (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * admin-api renders and searches these rows; it never writes them. Every
 * mutation goes out as a `request.billing.admin.*Discount*` command and comes
 * back as a snapshot, so there is exactly one writer and one set of rules.
 * `synchronize: false` keeps admin's schema synchroniser out of a table it
 * does not own, and the ADR-012 drift validator recognises the mapping as
 * external because it declares billing's schema.
 *
 * Same pattern as `analytics/entities/external/*` — see that directory for the
 * cross-service read precedent.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type {
  BillingDiscountAppliesTo,
  BillingDiscountDuration,
  BillingDiscountType,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A percentage is a rate, not money: `numeric(5,2)` cannot hold a nonsense
 * one, and the transformer keeps it exact through the read.
 */
const PERCENT_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

@Entity('discount_codes', { schema: 'billing', synchronize: false })
export class DiscountCodeReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', name: 'discount_type' })
  discountType!: BillingDiscountType;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'percent_off',
    transformer: PERCENT_TRANSFORMER,
  })
  percentOff!: Decimal | null;

  @MoneyColumn({ name: 'amount_off', nullable: true })
  amountOff!: Decimal | null;

  @Column({ type: 'int', nullable: true, name: 'free_months' })
  freeMonths!: number | null;

  @Column({ type: 'int', nullable: true, name: 'trial_extension_days' })
  trialExtensionDays!: number | null;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', name: 'applies_to' })
  appliesTo!: BillingDiscountAppliesTo;

  @Column({ type: 'jsonb', nullable: true, name: 'applicable_plan_ids' })
  applicablePlanIds!: string[] | null;

  @Column({ type: 'varchar' })
  duration!: BillingDiscountDuration;

  @Column({ type: 'int', nullable: true, name: 'duration_in_months' })
  durationInMonths!: number | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'valid_from' })
  validFrom!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'valid_until' })
  validUntil!: Date | null;

  @Column({ type: 'int', nullable: true, name: 'max_redemptions' })
  maxRedemptions!: number | null;

  @Column({ type: 'int', name: 'current_redemptions' })
  currentRedemptions!: number;

  @Column({ type: 'int', nullable: true, name: 'max_redemptions_per_tenant' })
  maxRedemptionsPerTenant!: number | null;

  @MoneyColumn({ name: 'minimum_order_amount', nullable: true })
  minimumOrderAmount!: Decimal | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'campaign_id' })
  campaignId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'campaign_name' })
  campaignName!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_promotion_code_id' })
  stripePromotionCodeId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_coupon_id' })
  stripeCouponId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'boolean', name: 'is_referral_code' })
  isReferralCode!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'referrer_id' })
  referrerId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'updated_by' })
  updatedBy!: string | null;
}

@Entity('discount_redemptions', { schema: 'billing', synchronize: false })
export class DiscountRedemptionReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'discount_code_id' })
  discountCodeId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'subscription_id' })
  subscriptionId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'invoice_id' })
  invoiceId!: string | null;

  @MoneyColumn({ name: 'discount_amount' })
  discountAmount!: Decimal;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'redeemed_at' })
  redeemedAt!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'redeemed_by' })
  redeemedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
