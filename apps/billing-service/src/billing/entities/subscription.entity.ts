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
import { ObjectType, Field, ID, registerEnumType, Float, Int } from '@nestjs/graphql';
import { forwardRef } from '@nestjs/common';

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
  @Field(() => Float)
  basePrice!: number;

  @Field(() => Float, { nullable: true })
  perFarmPrice?: number;

  @Field(() => Float, { nullable: true })
  perSensorPrice?: number;

  @Field(() => Float, { nullable: true })
  perUserPrice?: number;

  @Field()
  currency!: string;
}

@ObjectType()
@Entity('subscriptions')
@Index(['tenantId'], { unique: true })
@Index(['status'])
@Index(['currentPeriodEnd'])
export class Subscription {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field(() => PlanTier)
  @Column({ type: 'enum', enum: PlanTier })
  planTier!: PlanTier;

  @Field()
  @Column()
  planName!: string;

  @Field(() => SubscriptionStatus)
  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL })
  status!: SubscriptionStatus;

  @Field(() => BillingCycle)
  @Column({ type: 'enum', enum: BillingCycle })
  billingCycle!: BillingCycle;

  @Field(() => PlanLimits)
  @Column('jsonb')
  limits!: PlanLimits;

  @Field(() => PlanPricing)
  @Column('jsonb')
  pricing!: PlanPricing;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  startDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  endDate?: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  currentPeriodStart!: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  currentPeriodEnd!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  trialEndDate?: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  cancellationReason?: string;

  @Field()
  @Column({ default: true })
  autoRenew!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  stripeSubscriptionId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  stripeCustomerId?: string;

  @Field(() => [require('./invoice.entity').Invoice], { nullable: true })
  @OneToMany(
    () => require('./invoice.entity').Invoice,
    (invoice: { subscription: unknown }) => invoice.subscription,
  )
  invoices?: Array<import('./invoice.entity').Invoice>;

  /**
   * Module items included in this subscription
   */
  @Field(() => [require('./subscription-module-item.entity').SubscriptionModuleItem], { nullable: true })
  @OneToMany(
    () => require('./subscription-module-item.entity').SubscriptionModuleItem,
    (item: { subscription: unknown }) => item.subscription,
  )
  moduleItems?: Array<import('./subscription-module-item.entity').SubscriptionModuleItem>;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

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
