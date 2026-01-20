import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Plan tier enum - aligns with billing-service
 */
export enum PlanTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

/**
 * Billing cycle options
 */
export enum BillingCycle {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMI_ANNUAL = 'semi_annual',
  ANNUAL = 'annual',
}

/**
 * Plan visibility for marketplace
 */
export enum PlanVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  DEPRECATED = 'deprecated',
}

/**
 * Plan limits configuration
 */
export interface PlanLimits {
  maxUsers: number; // -1 = unlimited
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxModules: number;
  storageGB: number;
  dataRetentionDays: number;
  apiRateLimit: number; // requests per minute
  alertsEnabled: boolean;
  reportsEnabled: boolean;
  customBrandingEnabled: boolean;
  apiAccessEnabled: boolean;
  customIntegrationsEnabled: boolean;
  ssoEnabled: boolean;
  auditLogEnabled: boolean;
  prioritySupport: boolean;
  dedicatedAccountManager: boolean;
}

/**
 * Pricing configuration for different billing cycles
 */
export interface PlanPricing {
  monthly: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
  };
  quarterly: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  semiAnnual: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  annual: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  currency: string;
}

/**
 * Features included in the plan
 */
export interface PlanFeatures {
  coreFeatures: string[];
  advancedFeatures: string[];
  premiumFeatures: string[];
  addOns: Array<{
    code: string;
    name: string;
    description: string;
    price: number;
    billingCycle: BillingCycle;
  }>;
}

/**
 * Plan Definition Entity
 * Centralized management of all subscription plans
 */
@Entity('plan_definitions')
@Index(['tier'])
@Index(['visibility'])
@Index(['isActive'])
export class PlanDefinition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  code!: string; // e.g., 'starter_2024', 'pro_v2'

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'text', nullable: true })
  shortDescription?: string;

  @Column({ type: 'enum', enum: PlanTier })
  tier!: PlanTier;

  @Column({ type: 'enum', enum: PlanVisibility, default: PlanVisibility.PUBLIC })
  visibility!: PlanVisibility;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isRecommended!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @Column('jsonb')
  limits!: PlanLimits;

  @Column('jsonb')
  pricing!: PlanPricing;

  @Column('jsonb')
  features!: PlanFeatures;

  @Column({ type: 'int', nullable: true })
  trialDays?: number;

  @Column({ type: 'int', nullable: true })
  gracePeriodDays?: number;

  @Column({ type: 'text', nullable: true })
  upgradeMessage?: string;

  @Column({ type: 'text', nullable: true })
  downgradeWarning?: string;

  @Column({ nullable: true })
  stripeProductId?: string;

  @Column('jsonb', { nullable: true })
  stripePriceIds?: Record<string, string>; // billing cycle -> stripe price id

  @Column({ nullable: true })
  icon?: string;

  @Column({ nullable: true })
  color?: string;

  @Column({ nullable: true })
  badge?: string; // e.g., 'Best Value', 'Most Popular'

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  createdBy?: string;

  @Column({ nullable: true })
  updatedBy?: string;
}
