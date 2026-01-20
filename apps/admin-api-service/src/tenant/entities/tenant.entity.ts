import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TenantStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
  // For code compatibility (map to same db values)
  DEACTIVATED = 'CANCELLED',
  ARCHIVED = 'CANCELLED',
}

export enum TenantPlan {
  TRIAL = 'trial',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

// Backwards compatibility alias
export const TenantTier = TenantPlan;
export type TenantTier = TenantPlan;

export interface TenantSettings {
  timezone?: string;
  locale?: string;
  currency?: string;
  dateFormat?: string;
  measurementSystem?: 'metric' | 'imperial';
  notificationPreferences?: {
    email: boolean;
    sms: boolean;
    push: boolean;
    slack: boolean;
  };
  features?: string[];
}

// Read from public schema - read-only reference to auth-service's tenants table
@Entity('tenants', { schema: 'public', synchronize: false })
@Index(['status'])
@Index(['slug'])
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 20, default: TenantStatus.PENDING })
  status!: string;

  @Column({ type: 'varchar', length: 20, default: TenantPlan.STARTER })
  plan!: string;

  @Column({ type: 'int', default: 5 })
  maxUsers!: number;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  subscriptionEndsAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  settings?: TenantSettings;

  @Column({ type: 'varchar', length: 500, nullable: true })
  logoUrl?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  contactEmail?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone?: string;

  @Column({ type: 'text', nullable: true })
  address?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  taxId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  customDomain?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'uuid', nullable: true })
  createdBy?: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  // Backwards compatibility - these properties are NOT in the database
  // but exist for code compatibility with other services
  domain?: string; // Use customDomain instead
  country?: string;
  region?: string;
  suspendedAt?: Date;
  suspendedReason?: string;
  suspendedBy?: string;
  lastActivityAt?: Date;
  billingEmail?: string;
  primaryContact?: { name: string; email: string; phone?: string; role: string };
  billingContact?: { name: string; email: string; phone?: string; role: string };
  version?: number;

  // Backwards compatibility getter for 'tier' -> 'plan'
  get tier(): string {
    return this.plan;
  }

  set tier(value: string) {
    this.plan = value;
  }

  // Computed properties for backwards compatibility
  get userCount(): number {
    return 0; // Not tracked in this table
  }

  get farmCount(): number {
    return 0; // Not tracked in this table
  }

  get sensorCount(): number {
    return 0; // Not tracked in this table
  }

  // Limits getter for backwards compatibility (extended for all expected properties)
  get limits(): {
    maxUsers: number;
    maxFarms: number;
    maxPonds: number;
    maxSensors: number;
    maxAlertRules: number;
    dataRetentionDays: number;
    apiRateLimit: number;
    storageGb: number;
  } {
    return {
      maxUsers: this.maxUsers,
      maxFarms: -1, // unlimited
      maxPonds: -1,
      maxSensors: -1,
      maxAlertRules: -1,
      dataRetentionDays: 365,
      apiRateLimit: 1000,
      storageGb: -1,
    };
  }

  // Helper methods
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE || this.status === 'ACTIVE';
  }

  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED || this.status === 'SUSPENDED';
  }

  isTrialExpired(): boolean {
    if (!this.trialEndsAt) return false;
    return new Date() > this.trialEndsAt;
  }

  canAddUsers(count: number = 1): boolean {
    if (this.maxUsers === -1) return true; // unlimited
    return count <= this.maxUsers;
  }

  canAddFarms(_count: number = 1): boolean {
    return true; // No limit in this schema
  }

  canAddSensors(_count: number = 1): boolean {
    return true; // No limit in this schema
  }
}

// Tenant Invitation entity
@Entity('tenant_invitations', { schema: 'public', synchronize: false })
@Index(['email', 'tenantId'])
@Index(['token'])
@Index(['expiresAt'])
export class TenantInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  token!: string;

  @Column({ type: 'varchar', length: 50 })
  role!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  invitedBy?: string;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Date;

  @Column({ type: 'boolean', default: false })
  accepted!: boolean;

  @Column({ type: 'timestamp with time zone', nullable: true })
  acceptedAt?: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }
}
