/**
 * Tenant Entity (Read-only reference)
 *
 * This is a read-only view of the tenant table owned by auth-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is auth-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, ViewEntity } from 'typeorm';

export enum TenantPlan {
  TRIAL = 'TRIAL',
  STARTER = 'STARTER',
  PROFESSIONAL = 'PROFESSIONAL',
  ENTERPRISE = 'ENTERPRISE',
}

export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  PENDING = 'PENDING',
  CANCELLED = 'CANCELLED',
}

// Read from public schema (shared database) - read-only reference
@Entity('tenants', { schema: 'public', synchronize: false })
export class TenantReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', unique: true, length: 100 })
  slug: string;

  @Column({ type: 'varchar', length: 20, default: TenantStatus.PENDING })
  status: TenantStatus;

  @Column({ type: 'varchar', length: 20, default: TenantPlan.TRIAL })
  plan: TenantPlan;

  @Column({ type: 'int', default: 5 })
  maxUsers: number;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  subscriptionEndsAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
