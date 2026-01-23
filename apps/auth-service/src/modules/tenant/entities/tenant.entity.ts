import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Tenant subscription/plan types
 */
export enum TenantPlan {
  TRIAL = 'trial',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

registerEnumType(TenantPlan, {
  name: 'TenantPlan',
  description: 'Tenant subscription plans',
});

/**
 * Tenant status
 */
export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  PENDING = 'PENDING',
  CANCELLED = 'CANCELLED',
}

registerEnumType(TenantStatus, {
  name: 'TenantStatus',
  description: 'Tenant account status',
});

/**
 * Tenant Entity
 *
 * Represents a tenant (company/organization) in the multi-tenant system.
 * Each tenant has:
 * - Their own users (TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)
 * - Assigned modules (via TenantModule)
 * - Isolated data in all microservices
 */
@ObjectType()
@Entity('tenants')
@Index('IDX_tenants_slug', ['slug'], { unique: true })
@Index('IDX_tenants_status', ['status'])
export class Tenant {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Company/Organization name
   */
  @Field()
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /**
   * URL-friendly unique identifier (e.g., 'acme-corp')
   * Used in subdomains or URL paths
   */
  @Field()
  @Column({ type: 'varchar', unique: true, length: 100 })
  slug: string;

  /**
   * Company description
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Company logo URL
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 500, nullable: true })
  logoUrl: string | null;

  /**
   * Primary contact email
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  contactEmail: string | null;

  /**
   * Primary contact phone
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone: string | null;

  /**
   * Company address
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  address: string | null;

  /**
   * Tax ID / Company registration number
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  taxId: string | null;

  /**
   * Tenant status
   */
  @Field(() => TenantStatus)
  @Column({
    type: 'varchar',
    length: 20,
    default: TenantStatus.PENDING,
  })
  status: TenantStatus;

  /**
   * Subscription plan
   */
  @Field(() => TenantPlan)
  @Column({
    type: 'varchar',
    length: 20,
    default: TenantPlan.STARTER,
  })
  plan: TenantPlan;

  /**
   * Maximum number of users allowed
   */
  @Field()
  @Column({ type: 'int', default: 5 })
  maxUsers: number;

  /**
   * Trial end date (if on trial)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date | null;

  /**
   * Subscription end date
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  subscriptionEndsAt: Date | null;

  /**
   * Custom domain (if enterprise)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  customDomain: string | null;

  /**
   * Tenant settings (JSON)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  settings: Record<string, unknown> | null;

  /**
   * Created by (SUPER_ADMIN user ID)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  // ============================================
  // Helper Methods
  // ============================================

  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }

  isPending(): boolean {
    return this.status === TenantStatus.PENDING;
  }

  isOnTrial(): boolean {
    if (this.plan !== TenantPlan.TRIAL) return false;
    if (!this.trialEndsAt) return true;
    return this.trialEndsAt > new Date();
  }

  isTrialExpired(): boolean {
    if (this.plan !== TenantPlan.TRIAL) return false;
    if (!this.trialEndsAt) return false;
    return this.trialEndsAt < new Date();
  }

  isSubscriptionExpired(): boolean {
    if (!this.subscriptionEndsAt) return false;
    return this.subscriptionEndsAt < new Date();
  }

  /**
   * Generate slug from company name
   */
  static generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
