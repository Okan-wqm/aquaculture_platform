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

import { Tenant } from './tenant.entity';


/**
 * TenantModule Entity
 *
 * Junction table linking Tenants to Modules.
 * Determines which modules a tenant has access to.
 *
 * Created by SUPER_ADMIN when assigning modules to a tenant.
 */
@ObjectType()
@Entity('tenant_modules')
@Unique('UQ_tenant_module', ['tenantId', 'moduleId'])
@Index('IDX_tenant_modules_tenant', ['tenantId'])
@Index('IDX_tenant_modules_module', ['moduleId'])
export class TenantModule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant ID
   */
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * Module ID
   */
  @Field()
  @Column({ type: 'uuid' })
  moduleId!: string;

  /**
   * Module is enabled for this tenant
   */
  @Field()
  @Column({ type: 'boolean', default: true })
  isEnabled!: boolean;

  /**
   * Custom configuration for this tenant's module instance (JSON)
   * Can override default module settings
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  configuration?: Record<string, unknown> | null;

  /**
   * Maximum users allowed for this module (tenant-specific limit)
   * NULL means use tenant's global maxUsers
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'int', nullable: true })
  maxModuleUsers?: number | null;

  /**
   * Activation date (when module became available to tenant)
   */
  @Field()
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  activatedAt!: Date;

  /**
   * Expiration date (for time-limited module access)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date | null;

  /**
   * Notes about this assignment (for admin reference)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  /**
   * Assigned by (SUPER_ADMIN user ID)
   */
  @Field()
  @Column({ type: 'uuid' })
  assignedBy!: string;

  /**
   * Module Manager (TENANT_ADMIN can assign MODULE_MANAGER)
   * User who is responsible for managing this module within the tenant
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  managerId?: string | null;

  // ============================================
  // Relations
  // ============================================

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

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
    if (!this.isEnabled) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return this.expiresAt < new Date();
  }
}
