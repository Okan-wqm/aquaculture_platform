/**
 * Usage Aggregation Entity
 *
 * Database persistence for aggregated usage data.
 * Replaces in-memory Map storage for fault tolerance.
 */

import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { AggregationPeriod, AggregationDimension } from '../usage-aggregator.service';
import { MeterType } from '../usage-metering.service';

@Entity('usage_aggregations', { schema: 'billing' })
@Index(['tenantId', 'period', 'periodStart'])
@Index(['tenantId', 'meterType'])
export class UsageAggregation {
  /**
   * Composite key: tenantId:meterType:period:periodStart
   */
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
  dimension?: AggregationDimension;

  @Column({ type: 'varchar', length: 255, nullable: true })
  dimensionValue?: string;

  @Column('decimal', { precision: 20, scale: 6, default: 0, transformer: new DecimalTransformer() })
  totalUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0, transformer: new DecimalTransformer() })
  peakUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0, transformer: new DecimalTransformer() })
  averageUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, nullable: true, transformer: new DecimalTransformer() })
  minUsage!: number | null;

  @Column('decimal', { precision: 20, scale: 6, default: 0, transformer: new DecimalTransformer() })
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

/**
 * Hourly Data Entity for trend analysis
 */
@Entity('usage_hourly_data', { schema: 'billing' })
@Index(['tenantId', 'meterType'])
export class UsageHourlyData {
  @PrimaryColumn('varchar', { length: 100 })
  id!: string; // tenantId:meterType:hourly

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 50 })
  meterType!: MeterType;

  /**
   * Store hourly values as JSONB array (max 8760 = 1 year)
   */
  @Column('jsonb', { default: [] })
  values!: number[];

  @UpdateDateColumn()
  updatedAt!: Date;
}
