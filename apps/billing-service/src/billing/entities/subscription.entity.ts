import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, HideField, ID, registerEnumType, Float, Int } from '@nestjs/graphql';
// Billing's plan-tier enum is the canonical `BillingPlanTier` SSoT
// (@platform/event-contracts). Re-exported under the historical name `PlanTier`
// so every downstream billing import (dto, resolver, scheduler, handlers) is
// unchanged, and registered as the GraphQL `PlanTier` enum below. Faz D (D8)
// collapsed six hand-copied tier enums onto that one definition.
import { BillingPlanTier as PlanTier } from '@platform/event-contracts';
// forwardRef removed - not needed with string-based lazy loading

export { PlanTier };

export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  EXPIRED = 'expired',
}

export enum BillingCycle {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMI_ANNUAL = 'semi_annual',
  ANNUAL = 'annual',
}

registerEnumType(SubscriptionStatus, { name: 'SubscriptionStatus' });
registerEnumType(BillingCycle, { name: 'BillingCycle' });
registerEnumType(PlanTier, { name: 'PlanTier' });

@ObjectType()
export class PlanLimits {
  @Field(() => Int)
  maxFarms!: number;

  @Field(() => Int)
  maxPonds!: number;

  @Field(() => Int)
  maxSensors!: number;

  @Field(() => Int)
  maxUsers!: number;

  @Field(() => Int)
  dataRetentionDays!: number;

  @Field()
  alertsEnabled!: boolean;

  @Field()
  reportsEnabled!: boolean;

  @Field()
  apiAccessEnabled!: boolean;

  @Field()
  customIntegrationsEnabled!: boolean;
}

@ObjectType()
export class PlanPricing {
  @Field(() => Float, {
    deprecationReason: 'Use basePriceDecimal (exact decimal string, ADR-0004).',
  })
  basePrice!: number;

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use perFarmPriceDecimal (exact decimal string, ADR-0004).',
  })
  perFarmPrice?: number;

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use perSensorPriceDecimal (exact decimal string, ADR-0004).',
  })
  perSensorPrice?: number;

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use perUserPriceDecimal (exact decimal string, ADR-0004).',
  })
  perUserPrice?: number;

  @Field()
  currency!: string;
}

@ObjectType()
@Entity('subscriptions', { schema: 'billing' })
// DBR-HIGH-001 cure: full-unique on tenantId collides with the
// documented soft-delete pattern (is_deleted + deleted_at) — re-subscription
// after a tenant cancels would fail because the soft-deleted row still
// occupies the unique slot. The partial unique index restricts uniqueness
// to ACTIVE rows (is_deleted = false), letting historical canceled
// subscriptions co-exist with the current active subscription per tenant.
// The bare @Index entry below registers the supporting non-unique
// index for tenantId-only lookups.
@Index('IDX_subscriptions_tenantId', ['tenantId'])
@Index('UQ_subscriptions_tenantId_active', ['tenantId'], {
  unique: true,
  where: '"is_deleted" = false',
})
@Index(['status'])
@Index(['currentPeriodEnd'])
export class Subscription {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true, name: 'plan_id' })
  planId?: string;

  @Field(() => PlanTier)
  @Column({ type: 'enum', enum: PlanTier, name: 'plan_tier' })
  planTier!: PlanTier;

  @Field()
  @Column({ name: 'plan_name' })
  planName!: string;

  @Field(() => SubscriptionStatus)
  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL })
  status!: SubscriptionStatus;

  @Field(() => BillingCycle)
  @Column({ type: 'enum', enum: BillingCycle, name: 'billing_cycle' })
  billingCycle!: BillingCycle;

  @Field(() => PlanLimits)
  @Column('jsonb')
  limits!: PlanLimits;

  @Field(() => PlanPricing)
  @Column('jsonb')
  pricing!: PlanPricing;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'start_date' })
  startDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'end_date' })
  endDate?: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'current_period_start' })
  currentPeriodStart!: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'current_period_end' })
  currentPeriodEnd!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'trial_end_date' })
  trialEndDate?: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelledAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true, name: 'cancellation_reason' })
  cancellationReason?: string;

  @Field()
  @Column({ default: true, name: 'auto_renew' })
  autoRenew!: boolean;

  @HideField()
  @Column({ nullable: true, name: 'stripe_subscription_id' })
  stripeSubscriptionId?: string;

  @HideField()
  @Column({ nullable: true, name: 'stripe_customer_id' })
  stripeCustomerId?: string;

  // Note: invoices field resolved via field resolver to avoid circular dependency
  @OneToMany('Invoice', 'subscription')
  invoices?: Array<import('./invoice.entity').Invoice>;

  /**
   * Module items included in this subscription
   * Note: moduleItems field resolved via field resolver to avoid circular dependency
   */
  @OneToMany('SubscriptionModuleItem', 'subscription')
  moduleItems?: Array<import('./subscription-module-item.entity').SubscriptionModuleItem>;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'created_by' })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  // Soft-delete: subscription history must be preserved for billing reconciliation and customer disputes.
  // Physical deletion of a subscription record removes the audit trail for all associated invoices and payments.
  // BEFORE: no soft-delete — subscription records could be permanently removed.
  @Field()
  @Column({ default: false, name: 'is_deleted' })
  @Index()
  isDeleted: boolean = false;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column({ nullable: true, name: 'deleted_by' })
  deletedBy?: string;

  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
  }

  /**
   * Normalize plan name before save
   */
  @BeforeInsert()
  @BeforeUpdate()
  sanitize(): void {
    if (this.planName) {
      this.planName = this.planName.trim();
    }
  }
}
