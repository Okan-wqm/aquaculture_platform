import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';

/**
 * Announcement type/severity
 */
export enum AnnouncementType {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
  MAINTENANCE = 'maintenance',
}

registerEnumType(AnnouncementType, {
  name: 'AnnouncementType',
  description: 'Announcement type/severity',
});

/**
 * Announcement status
 */
export enum AnnouncementStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  PUBLISHED = 'published',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

registerEnumType(AnnouncementStatus, {
  name: 'AnnouncementStatus',
  description: 'Announcement publication status',
});

/**
 * Announcement scope
 */
export enum AnnouncementScope {
  PLATFORM = 'platform', // Created by SuperAdmin, visible to all/targeted tenants
  TENANT = 'tenant', // Created by TenantAdmin, visible to tenant users
}

registerEnumType(AnnouncementScope, {
  name: 'AnnouncementScope',
  description: 'Who can create/see the announcement',
});

/**
 * Announcement target criteria (for platform-wide)
 */
@ObjectType()
export class AnnouncementTarget {
  @Field(() => [String], { nullable: true })
  tenantIds?: string[];

  @Field(() => [String], { nullable: true })
  excludeTenantIds?: string[];

  @Field(() => [String], { nullable: true })
  plans?: string[]; // tenant plans: trial, starter, professional, enterprise

  @Field(() => [String], { nullable: true })
  modules?: string[]; // specific modules

  @Field(() => [String], { nullable: true })
  regions?: string[];
}

/**
 * Announcement Entity
 *
 * Platform-wide announcements (by SuperAdmin) or
 * Tenant-level announcements (by TenantAdmin for their users).
 */
@Entity('announcements')
@ObjectType()
@Index(['scope', 'status'])
@Index(['tenantId', 'status'])
@Index(['publishAt'])
export class Announcement {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id!: string;

  @Column()
  @Field()
  title!: string;

  @Column({ type: 'text' })
  @Field()
  content!: string;

  @Column({ type: 'enum', enum: AnnouncementType, default: AnnouncementType.INFO })
  @Field(() => AnnouncementType)
  type!: AnnouncementType;

  @Column({ type: 'enum', enum: AnnouncementStatus, default: AnnouncementStatus.DRAFT })
  @Field(() => AnnouncementStatus)
  status!: AnnouncementStatus;

  @Column({ type: 'enum', enum: AnnouncementScope })
  @Field(() => AnnouncementScope)
  scope!: AnnouncementScope;

  // For PLATFORM scope - null means global
  // For TENANT scope - creator's tenant
  @Column({ type: 'uuid', nullable: true })
  @Field(() => String, { nullable: true })
  @Index()
  tenantId?: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant | null;

  // For PLATFORM scope only - targeting
  @Column({ default: true })
  @Field()
  isGlobal!: boolean; // true = all tenants, false = use targetCriteria

  @Column({ type: 'jsonb', nullable: true })
  @Field(() => AnnouncementTarget, { nullable: true })
  targetCriteria?: AnnouncementTarget | null;

  // Scheduling
  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  publishAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;

  // Acknowledgment
  @Column({ default: false })
  @Field()
  requiresAcknowledgment!: boolean;

  // Stats
  @Column({ default: 0 })
  @Field()
  viewCount!: number;

  @Column({ default: 0 })
  @Field()
  acknowledgmentCount!: number;

  // Creator
  @Column({ type: 'uuid' })
  @Field()
  createdBy!: string;

  @Column()
  @Field()
  createdByName!: string;

  @CreateDateColumn()
  @Field()
  createdAt!: Date;

  @UpdateDateColumn()
  @Field()
  updatedAt!: Date;

  /**
   * Check if announcement is currently active
   */
  isActive(): boolean {
    if (this.status !== AnnouncementStatus.PUBLISHED) return false;
    const now = new Date();
    if (this.publishAt && new Date(this.publishAt) > now) return false;
    if (this.expiresAt && new Date(this.expiresAt) < now) return false;
    return true;
  }

  /**
   * Check if tenant matches target criteria
   */
  matchesTenant(tenantId: string, tenantPlan?: string, tenantModules?: string[]): boolean {
    if (this.scope === AnnouncementScope.TENANT) {
      return this.tenantId === tenantId;
    }

    if (this.isGlobal) return true;
    if (!this.targetCriteria) return true;

    const criteria = this.targetCriteria;

    // Check exclusions first
    if (criteria.excludeTenantIds?.includes(tenantId)) return false;

    // Check specific tenant IDs
    if (criteria.tenantIds?.length && !criteria.tenantIds.includes(tenantId)) {
      return false;
    }

    // Check plan
    if (criteria.plans?.length && tenantPlan && !criteria.plans.includes(tenantPlan)) {
      return false;
    }

    // Check modules
    if (criteria.modules?.length && tenantModules) {
      const hasModule = criteria.modules.some(m => tenantModules.includes(m));
      if (!hasModule) return false;
    }

    return true;
  }
}
