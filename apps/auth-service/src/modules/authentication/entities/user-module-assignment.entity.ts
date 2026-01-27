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

import { Module } from '../../system-module/entities/module.entity';

import { User } from './user.entity';


/**
 * UserModuleAssignment Entity
 *
 * Links users to specific modules they have access to.
 * - TENANT_ADMIN: Can access ALL modules assigned to their tenant (no entries needed)
 * - MODULE_MANAGER: Has entries for modules they manage
 * - MODULE_USER: Has entries for modules they can access
 *
 * This entity is only used for MODULE_MANAGER and MODULE_USER roles.
 * TENANT_ADMINs inherit access from TenantModule assignments.
 */
@ObjectType()
@Entity('user_module_assignments')
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
   * Assignment expiration date (for temporary assignments)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
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
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
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
