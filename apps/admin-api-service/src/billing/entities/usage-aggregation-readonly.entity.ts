/**
 * Usage Aggregation Entity (Read-only reference)
 *
 * This is a read-only view of the usage_aggregations table owned by billing-service.
 * Used for metered billing analytics in the admin dashboard.
 * DO NOT modify - source of truth is billing-service's MeteringModule.
 */

import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum AggregationPeriod {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

export enum MeterType {
  API_CALLS = 'api_calls',
  DATA_STORAGE = 'data_storage',
  SENSOR_READINGS = 'sensor_readings',
  ALERTS_SENT = 'alerts_sent',
  REPORTS_GENERATED = 'reports_generated',
  USERS_ACTIVE = 'users_active',
  FARMS_ACTIVE = 'farms_active',
  PONDS_ACTIVE = 'ponds_active',
  SENSORS_ACTIVE = 'sensors_active',
  DATA_EXPORT = 'data_export',
  INTEGRATIONS = 'integrations',
  CUSTOM = 'custom',
}

@Entity('usage_aggregations', { schema: 'billing', synchronize: false })
@Index(['tenantId', 'period', 'periodStart'])
@Index(['tenantId', 'meterType'])
export class UsageAggregationReadOnly {
  @PrimaryColumn('varchar', { length: 255 })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 20 })
  period!: AggregationPeriod;

  @Column({ type: 'timestamptz' })
  periodStart!: Date;

  @Column({ type: 'timestamptz' })
  periodEnd!: Date;

  @Column({ type: 'varchar', length: 50 })
  meterType!: MeterType;

  @Column({ type: 'varchar', length: 20, nullable: true })
  dimension?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  dimensionValue?: string;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  totalUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  peakUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  averageUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, nullable: true })
  minUsage!: number | null;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  maxUsage!: number;

  @Column('int', { default: 0 })
  eventCount!: number;

  @Column({ type: 'varchar', length: 50 })
  unit!: string;

  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
