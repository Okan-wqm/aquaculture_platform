/**
 * Tenant Usage Metrics Entity (Read-only reference)
 *
 * This is a read-only view of the tenant_usage_metrics table owned by billing-service.
 * Used for metered billing analytics in the admin dashboard.
 * DO NOT modify - source of truth is billing-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, Unique } from 'typeorm';

export enum UsagePeriodType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  BILLING_PERIOD = 'billing_period',
}

export interface MetricUsage {
  current: number;
  peak: number;
  average: number;
  total?: number;
}

export interface ModuleUsageMetrics {
  users?: MetricUsage;
  farms?: MetricUsage;
  ponds?: MetricUsage;
  sensors?: MetricUsage;
  devices?: MetricUsage;
  storageGb?: MetricUsage;
  apiCalls?: MetricUsage;
  alerts?: MetricUsage;
  reports?: MetricUsage;
  dataTransferGb?: MetricUsage;
}

@Entity('tenant_usage_metrics', { schema: 'billing', synchronize: false })
@Index(['tenantId'])
@Index(['moduleId'])
@Index(['periodStart'])
@Index(['periodType'])
@Unique(['tenantId', 'moduleId', 'periodStart', 'periodType'])
export class TenantUsageMetricsReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'module_id', nullable: true })
  moduleId!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  moduleCode!: string | null;

  @Column({ type: 'enum', enum: UsagePeriodType })
  periodType!: UsagePeriodType;

  @Column({ type: 'date' })
  periodStart!: Date;

  @Column({ type: 'date' })
  periodEnd!: Date;

  @Column('jsonb', { default: {} })
  metrics!: ModuleUsageMetrics;

  @Column('decimal', { precision: 12, scale: 2, nullable: true })
  calculatedCost!: number | null;

  @Column('jsonb', { type: 'jsonb', nullable: true })
  includedQuantities!: Record<string, number> | null;

  @Column('jsonb', { type: 'jsonb', nullable: true })
  overageQuantities!: Record<string, number> | null;

  @Column({ default: false })
  isFinalized!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @Column('uuid', { type: 'varchar', nullable: true })
  invoiceId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
