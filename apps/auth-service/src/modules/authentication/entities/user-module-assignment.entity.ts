import { MODULE_ROLES, type ModuleRole } from '@aquaculture/shared-contracts';
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
  Check,
} from 'typeorm';

import { Module } from '../../system-module/entities/module.entity';

import { User } from './user.entity';


/**
 * UserModuleAssignment Entity
 *
 * A member's grant in one module, with the member's role in it (`role`, ADR-051 §2). The
 * `moduleAccess` token claim is built from these rows by the module-access reader
 * (services/module-access-reader.ts); TENANT_ADMIN needs no rows — the reader lists every module
 * the tenant has enabled — and users.role grants no module (it is an account role).
 */
@ObjectType()
@Entity('user_module_assignments', { schema: 'auth' })
// RBAC-HIGH-027: the store admits only the module roles. Mirrors the CHECK added by
// 1819300000000-AddUserModuleAssignmentRole, so the drift validator's class-G count stays even.
@Check(
  'CHK_user_module_assignments_role',
  `"role" IN (${MODULE_ROLES.map((role) => `'${role}'`).join(', ')})`,
)
@Unique('UQ_user_module', ['userId', 'moduleId'])
@Index('IDX_user_module_assignments_user', ['userId'])
@Index('IDX_user_module_assignments_module', ['moduleId'])
@Index('IDX_user_module_assignments_tenant', ['tenantId'])
export class UserModuleAssignment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * User ID
   */
  @Field()
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Module ID
   */
  @Field()
  @Column({ type: 'uuid' })
  moduleId!: string;

  /**
   * Tenant ID (denormalized for faster queries)
   */
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * User is the primary manager for this module
   * Only one user can be primary manager per module per tenant
   */
  @Field()
  @Column({ type: 'boolean', default: false })
  isPrimaryManager!: boolean;

  /**
   * Assignment is active
   */
  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * The member's role in this module (RBAC-HIGH-027): MODULE_MANAGER or MODULE_USER. Nullable in
   * release R1 (C3): containers of the previous release insert rows without it until they are
   * replaced, and the module-access reader grants nothing for such a row. PKG-06 PR2 re-runs the
   * backfill and sets NOT NULL. Every writer sets it: setUserModuleAccess and Assign / Remove
   * Manager explicitly (module-grant-writes.ts), an invite through moduleAssignmentGrant.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  role!: ModuleRole | null;

  /**
   * Custom permissions within the module (JSON)
   * Allows fine-grained access control
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  permissions?: Record<string, boolean> | null;

  /**
   * Assigned by (TENANT_ADMIN or SUPER_ADMIN user ID)
   */
  @Field()
  @Column({ type: 'uuid' })
  assignedBy!: string;

  /**
   * Assignment expiration date (for time-limited assignments)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  /**
   * Notes about this assignment
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  // ============================================
  // Relations
  // ============================================

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @ManyToOne(() => Module, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'moduleId' })
  module!: Module;

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

  isAccessible(): boolean {
    if (!this.isActive) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return this.expiresAt < new Date();
  }

  /**
   * Check if user has a specific permission within the module
   */
  hasPermission(permissionKey: string): boolean {
    if (!this.permissions) return false;
    return this.permissions[permissionKey] === true;
  }
}
