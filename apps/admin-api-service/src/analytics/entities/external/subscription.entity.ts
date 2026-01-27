/**
 * Subscription Entity (Read-only reference)
 *
 * This is a read-only view of the subscription table owned by billing-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is billing-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

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

export enum PlanTier {
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

export interface PlanPricing {
  basePrice: number;
  perFarmPrice?: number;
  perSensorPrice?: number;
  perUserPrice?: number;
  currency: string;
}

// Read from public schema (shared database) - read-only reference
@Entity('subscriptions', { schema: 'public', synchronize: false })
export class SubscriptionReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenantId!: string;

  @Column({ type: 'enum', enum: PlanTier })
  planTier!: PlanTier;

  @Column()
  planName!: string;

  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL })
  status!: SubscriptionStatus;

  @Column({ type: 'enum', enum: BillingCycle })
  billingCycle!: BillingCycle;

  @Column('jsonb')
  pricing!: PlanPricing;

  @Column({ type: 'timestamptz' })
  startDate!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endDate!: Date | null;

  @Column({ type: 'timestamptz' })
  currentPeriodStart!: Date;

  @Column({ type: 'timestamptz' })
  currentPeriodEnd!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  trialEndDate!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ default: true })
  autoRenew!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
