/**
 * Subscription Entity (Read-only reference)
 *
 * This is a read-only view of the subscription table owned by billing-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is billing-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Read-model of billing.subscriptions — its plan_tier is the canonical
// `BillingPlanTier` SSoT (@platform/event-contracts), re-exported as `PlanTier`.
// Faz D (D8): the former local copy omitted FREE, so a FREE subscription row
// (Billing Revival Faz B added 'free' to the DB enum) had no matching member —
// sourcing from the SSoT restores it.
import { BillingPlanTier as PlanTier } from '@platform/event-contracts';

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

export interface PlanPricing {
  basePrice: number;
  perFarmPrice?: number;
  perSensorPrice?: number;
  perUserPrice?: number;
  currency: string;
}

// C-6 fix: billing-service stores subscriptions in the 'billing' schema, not 'public'
// Column names explicitly mapped to snake_case as defined by billing-service schema
@Entity('subscriptions', { schema: 'billing', synchronize: false })
export class SubscriptionReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'plan_tier', type: 'enum', enum: PlanTier })
  planTier!: PlanTier;

  @Column({ name: 'plan_name' })
  planName!: string;

  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL })
  status!: SubscriptionStatus;

  @Column({ name: 'billing_cycle', type: 'enum', enum: BillingCycle })
  billingCycle!: BillingCycle;

  @Column('jsonb')
  pricing!: PlanPricing;

  @Column({ name: 'start_date', type: 'timestamptz' })
  startDate!: Date;

  @Column({ name: 'end_date', type: 'timestamptz', nullable: true })
  endDate!: Date | null;

  @Column({ name: 'current_period_start', type: 'timestamptz' })
  currentPeriodStart!: Date;

  @Column({ name: 'current_period_end', type: 'timestamptz' })
  currentPeriodEnd!: Date;

  @Column({ name: 'trial_end_date', type: 'timestamptz', nullable: true })
  trialEndDate!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'auto_renew', default: true })
  autoRenew!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
