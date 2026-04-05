import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';

/**
 * Discount type
 */
export enum DiscountType {
  PERCENTAGE = 'percentage', // e.g., 20% off
  FIXED_AMOUNT = 'fixed_amount', // e.g., $50 off
  FREE_TRIAL_EXTENSION = 'free_trial_extension', // e.g., +14 days trial
  FREE_MONTHS = 'free_months', // e.g., 2 months free
}

/**
 * Discount applicability
 */
export enum DiscountAppliesTo {
  ALL_PLANS = 'all_plans',
  SPECIFIC_PLANS = 'specific_plans',
  UPGRADES_ONLY = 'upgrades_only',
  NEW_SUBSCRIPTIONS_ONLY = 'new_subscriptions_only',
}

/**
 * Discount duration
 */
export enum DiscountDuration {
  ONCE = 'once', // First payment only
  REPEATING = 'repeating', // Multiple billing cycles
  FOREVER = 'forever', // Permanent discount
}

/**
 * Discount Code / Coupon Entity
 */
@Entity('discount_codes')
@Index(['code'], { unique: true })
@Index(['isActive'])
@Index(['validFrom', 'validUntil'])
@Index(['campaignId'])
export class DiscountCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  code!: string; // e.g., 'SUMMER2024', 'WELCOME20'

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: DiscountType })
  discountType!: DiscountType;

  // DecimalTransformer: discountValue is either a percentage (10.5) or fixed amount (50.00).
  // Applied as: discountAmount = price * (discountValue / 100) or price - discountValue.
  // String division / multiplication produces NaN, breaking all discount calculations.
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: new DecimalTransformer() })
  discountValue!: number; // percent or fixed amount

  @Column({ type: 'enum', enum: DiscountAppliesTo, default: DiscountAppliesTo.ALL_PLANS })
  appliesTo!: DiscountAppliesTo;

  @Column('jsonb', { nullable: true })
  applicablePlanIds?: string[]; // if appliesTo is SPECIFIC_PLANS

  @Column({ type: 'enum', enum: DiscountDuration, default: DiscountDuration.ONCE })
  duration!: DiscountDuration;

  @Column({ type: 'int', nullable: true })
  durationInMonths?: number; // for REPEATING duration

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validUntil?: Date;

  @Column({ type: 'int', nullable: true })
  maxRedemptions?: number; // null = unlimited

  @Column({ type: 'int', default: 0 })
  currentRedemptions!: number;

  @Column({ type: 'int', nullable: true })
  maxRedemptionsPerTenant?: number; // max uses per tenant

  // DecimalTransformer: minimumOrderAmount is compared against subscription price to gate eligibility.
  // String comparison ("100.00" >= price) uses lexicographic order — "9.00" > "100.00" is true as string.
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  minimumOrderAmount?: number; // minimum subscription value to apply

  @Column({ nullable: true })
  campaignId?: string; // group codes by campaign

  @Column({ nullable: true })
  campaignName?: string;

  @Column({ nullable: true })
  stripePromotionCodeId?: string;

  @Column({ nullable: true })
  stripeCouponId?: string;

  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ default: false })
  isReferralCode!: boolean;

  @Column({ nullable: true })
  referrerId?: string; // tenant ID of referrer

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  createdBy?: string;

  @Column({ nullable: true })
  updatedBy?: string;
}

/**
 * Track discount code redemptions
 */
@Entity('discount_redemptions')
@Index(['discountCodeId'])
@Index(['tenantId'])
@Index(['redeemedAt'])
export class DiscountRedemption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  discountCodeId!: string;

  @Column()
  tenantId!: string;

  @Column({ nullable: true })
  subscriptionId?: string;

  @Column({ nullable: true })
  invoiceId?: string;

  // DecimalTransformer: discountAmount records the actual monetary discount applied per redemption.
  // Used in analytics (total savings per campaign). String sum produces concatenation.
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: new DecimalTransformer() })
  discountAmount!: number;

  @Column()
  currency!: string;

  @Column({ type: 'timestamptz' })
  redeemedAt!: Date;

  @Column({ nullable: true })
  redeemedBy?: string;

  @CreateDateColumn()
  createdAt!: Date;
}
