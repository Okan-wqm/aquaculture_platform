import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';

import { User } from './user.entity';

/**
 * UserSiteAssignment Entity (SEC-HIGH-051)
 *
 * WHY: object-level farm operations (mortality/cull/transfer/allocate/
 * water-quality/storage/harvest/feeding) must only be allowed for a user
 * assigned to the SITE the batch/tank/location belongs to. Coarse `@Roles(...)`
 * gates only prove tenant membership, so without a user->site link any
 * MODULE_USER could mutate ANY batch in their tenant regardless of physical
 * site. This entity IS that missing link — the SSoT for site membership that
 * {@link SiteAuthorizationService} consults beneath the role gate.
 *
 * WHAT: mirrors {@link UserModuleAssignment} exactly. This is a PLATFORM /
 * cross-tenant `auth`-schema table (every login resolves a tenant before any
 * other context), so it DECLARES `schema: 'auth'` explicitly per ADR-011 —
 * it is NOT a per-tenant table and is never cloned into tenant schemas.
 *
 * Role coverage follows the site-authorization hierarchy:
 * - SUPER_ADMIN / TENANT_ADMIN: no entries needed — they bypass site checks via
 *   the canonical `roleHasPermission(role, MODULE_MANAGER)` hierarchy.
 * - MODULE_MANAGER: no entries needed — managers have tenant-wide site access.
 * - MODULE_USER: has explicit rows for each assigned site.
 *
 * `siteId` is a farm-service Site id — a CROSS-SERVICE identifier. There is
 * deliberately NO `@ManyToOne`/FK to a farm entity: auth must not import farm
 * tables (a layering violation), and a cross-schema FK across service
 * boundaries is forbidden.
 */
@ObjectType()
@Entity('user_site_assignments', { schema: 'auth' })
@Unique('UQ_user_site', ['userId', 'siteId'])
@Index('IDX_user_site_assignments_user', ['userId'])
@Index('IDX_user_site_assignments_tenant', ['tenantId'])
@Index('IDX_user_site_assignments_user_tenant', ['userId', 'tenantId'])
export class UserSiteAssignment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * User ID (auth-service userId / JWT subject).
   */
  @Field()
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Site ID — a farm-service Site id (cross-service identifier, NOT an FK).
   */
  @Field()
  @Column({ type: 'uuid' })
  siteId!: string;

  /**
   * Tenant ID (denormalized for scoped loads).
   */
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * Assignment is active.
   */
  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * Assigned by (TENANT_ADMIN or SUPER_ADMIN user ID).
   */
  @Field()
  @Column({ type: 'uuid' })
  assignedBy!: string;

  /**
   * Assignment expiration date (for time-limited assignments).
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  // ============================================
  // Relations
  // ============================================

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'userId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  user!: User;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * A site assignment grants access only while active AND not expired.
   * Mirrors {@link UserModuleAssignment.isAccessible} so the staleness rule is
   * identical across module/site assignments.
   */
  isAccessible(): boolean {
    if (!this.isActive) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }
}
