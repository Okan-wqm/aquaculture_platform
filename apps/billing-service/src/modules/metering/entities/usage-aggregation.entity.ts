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
import { AggregationPeriod, AggregationDimension } from '../usage-aggregator.service';
import { MeterType } from '../usage-metering.service';

@Entity('usage_aggregations')
@Index(['tenantId', 'period', 'periodStart'])
@Index(['tenantId', 'meterType'])
export class UsageAggregation {
  /**
   * Composite key: tenantId:meterType:period:periodStart
   */
  @PrimaryColumn('varchar', { length: 255 })
  id!: string;

  @Column('uuid')
  @Index()
  tenantId!: string;

  @Column({ type: 'enum', enum: AggregationPeriod })
  period!: AggregationPeriod;

  @Column({ type: 'timestamptz' })
  periodStart!: Date;

  @Column({ type: 'timestamptz' })
  periodEnd!: Date;

  @Column({ type: 'enum', enum: MeterType })
  meterType!: MeterType;

  @Column({ type: 'enum', enum: AggregationDimension, nullable: true })
  dimension?: AggregationDimension;

  @Column({ type: 'varchar', length: 255, nullable: true })
  dimensionValue?: string;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  totalUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  peakUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: 0 })
  averageUsage!: number;

  @Column('decimal', { precision: 20, scale: 6, default: Number.MAX_VALUE })
  minUsage!: number;

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

/**
 * Hourly Data Entity for trend analysis
 */
@Entity('usage_hourly_data')
@Index(['tenantId', 'meterType'])
export class UsageHourlyData {
  @PrimaryColumn('varchar', { length: 100 })
  id!: string; // tenantId:meterType:hourly

  @Column('uuid')
  tenantId!: string;

  @Column({ type: 'enum', enum: MeterType })
  meterType!: MeterType;

  /**
   * Store hourly values as JSONB array (max 8760 = 1 year)
   */
  @Column('jsonb', { default: [] })
  values!: number[];

  @UpdateDateColumn()
  updatedAt!: Date;
}
