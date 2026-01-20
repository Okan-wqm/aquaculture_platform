import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';

/**
 * Usage tracking period type
 */
export enum UsagePeriodType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  BILLING_PERIOD = 'billing_period',
}

registerEnumType(UsagePeriodType, { name: 'UsagePeriodType' });

/**
 * Usage statistics for a metric
 */
@ObjectType()
export class MetricUsage {
  @Field(() => Float)
  current!: number;

  @Field(() => Float)
  peak!: number;

  @Field(() => Float)
  average!: number;

  @Field(() => Float, { nullable: true })
  total?: number; // For cumulative metrics like API calls
}

/**
 * All usage metrics for a module
 */
@ObjectType()
export class ModuleUsageMetrics {
  @Field(() => MetricUsage, { nullable: true })
  users?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  farms?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  ponds?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  sensors?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  devices?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  storageGb?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  apiCalls?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  alerts?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  reports?: MetricUsage;

  @Field(() => MetricUsage, { nullable: true })
  dataTransferGb?: MetricUsage;
}

/**
 * Tenant Usage Metrics Entity
 *
 * Tracks actual usage for each tenant's modules per billing period.
 * Used for:
 * - Usage-based billing (metered billing)
 * - Overage calculations
 * - Usage analytics and reporting
 * - Quota monitoring and alerts
 *
 * Example:
 * Tenant X, IoT Module, January 2024:
 * - Users: current=15, peak=18, average=14.5
 * - Sensors: current=50, peak=55, average=48
 * - Storage: current=20.5GB, peak=22.1GB
 * - API Calls: total=125000
 */
@ObjectType()
@Entity('tenant_usage_metrics')
@Index(['tenantId'])
@Index(['moduleId'])
@Index(['periodStart'])
@Index(['periodType'])
@Unique(['tenantId', 'moduleId', 'periodStart', 'periodType'])
export class TenantUsageMetrics {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant ID
   */
  @Field()
  @Column('uuid')
  tenantId!: string;

  /**
   * Module ID (null for tenant-wide metrics)
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  moduleId!: string | null;

  /**
   * Module code for convenience
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  moduleCode!: string | null;

  /**
   * Type of period
   */
  @Field(() => UsagePeriodType)
  @Column({ type: 'enum', enum: UsagePeriodType })
  periodType!: UsagePeriodType;

  /**
   * Period start date
   */
  @Field()
  @Column({ type: 'date' })
  periodStart!: Date;

  /**
   * Period end date
   */
  @Field()
  @Column({ type: 'date' })
  periodEnd!: Date;

  /**
   * Usage metrics
   */
  @Field(() => ModuleUsageMetrics)
  @Column('jsonb', { default: {} })
  metrics!: ModuleUsageMetrics;

  /**
   * Calculated cost based on usage
   */
  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 12, scale: 2, nullable: true })
  calculatedCost!: number | null;

  /**
   * Included quantities (from subscription)
   */
  @Column('jsonb', { nullable: true })
  includedQuantities!: Record<string, number> | null;

  /**
   * Overage quantities (usage - included)
   */
  @Column('jsonb', { nullable: true })
  overageQuantities!: Record<string, number> | null;

  /**
   * Whether this record is finalized (billing completed)
   */
  @Field()
  @Column({ default: false })
  isFinalized!: boolean;

  /**
   * When record was finalized
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  /**
   * Reference to invoice if billed
   */
  @Column('uuid', { nullable: true })
  invoiceId!: string | null;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get current usage for a metric
   */
  getCurrentUsage(metric: keyof ModuleUsageMetrics): number {
    const usage = this.metrics[metric];
    return usage?.current ?? 0;
  }

  /**
   * Get peak usage for a metric
   */
  getPeakUsage(metric: keyof ModuleUsageMetrics): number {
    const usage = this.metrics[metric];
    return usage?.peak ?? 0;
  }

  /**
   * Get total usage for cumulative metrics
   */
  getTotalUsage(metric: keyof ModuleUsageMetrics): number {
    const usage = this.metrics[metric];
    return usage?.total ?? usage?.current ?? 0;
  }

  /**
   * Calculate overage for a metric
   */
  calculateOverage(
    metric: keyof ModuleUsageMetrics,
    includedQty: number,
  ): number {
    const usage = this.getCurrentUsage(metric);
    return Math.max(0, usage - includedQty);
  }

  /**
   * Update a metric's current value
   */
  updateMetric(metric: keyof ModuleUsageMetrics, value: number): void {
    if (!this.metrics[metric]) {
      this.metrics[metric] = { current: 0, peak: 0, average: 0 };
    }

    const metricData = this.metrics[metric]!;
    metricData.current = value;
    metricData.peak = Math.max(metricData.peak, value);

    // Simple running average (can be improved)
    metricData.average = (metricData.average + value) / 2;
  }

  /**
   * Increment a cumulative metric (like API calls)
   */
  incrementMetric(metric: keyof ModuleUsageMetrics, amount: number = 1): void {
    if (!this.metrics[metric]) {
      this.metrics[metric] = { current: 0, peak: 0, average: 0, total: 0 };
    }

    const metricData = this.metrics[metric]!;
    metricData.total = (metricData.total ?? 0) + amount;
    metricData.current = metricData.total;
  }
}
