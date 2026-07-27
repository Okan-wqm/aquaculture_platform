/**
 * Usage Metering Management Service
 *
 * Provides read-only access to metered billing data for the admin dashboard.
 * Queries the billing schema's usage_aggregations table — the single usage
 * SSoT (A6 / DB-IDENT-MEDIUM-002; billing.tenant_usage_metrics was a dead
 * parallel model and has been retired).
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { DataSource } from 'typeorm';

import {
  UsageAggregationReadOnly,
  AggregationPeriod,
  MeterType,
} from '../entities/usage-aggregation-readonly.entity';

// ============================================================================
// DTOs and Interfaces
// ============================================================================

export interface UsageOverviewFilters {
  tenantId?: string;
  period?: AggregationPeriod;
  meterType?: MeterType;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

export interface TenantUsageOverview {
  tenantId: string;
  tenantName?: string;
  meters: {
    meterType: MeterType;
    totalUsage: number;
    unit: string;
    eventCount: number;
    peakUsage: number;
    averageUsage: number;
  }[];
  totalEvents: number;
  lastActivity?: Date;
}

export interface UsageTrendPoint {
  periodStart: Date;
  periodEnd: Date;
  meterType: MeterType;
  totalUsage: number;
  peakUsage: number;
  averageUsage: number;
  eventCount: number;
  unit: string;
}

export interface TopTenantUsage {
  tenantId: string;
  tenantName?: string;
  totalUsage: number;
  meterType: MeterType;
  unit: string;
  eventCount: number;
}

export interface UsageSummaryStats {
  totalTenants: number;
  totalEvents: number;
  meterBreakdown: {
    meterType: MeterType;
    totalUsage: number;
    avgPerTenant: number;
    maxPerTenant: number;
    unit: string;
    tenantCount: number;
  }[];
  periodCovered: {
    from: Date;
    to: Date;
  };
}

export interface BillingPreviewRequest {
  tenantId: string;
  periodStart?: string;
  periodEnd?: string;
}

@Injectable()
export class UsageMeteringManagementService {
  constructor(
    @InjectRepository(UsageAggregationReadOnly)
    private readonly aggregationRepo: Repository<UsageAggregationReadOnly>,
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================================
  // Usage Overview
  // ============================================================================

  /**
   * Get overall usage summary across all tenants
   */
  async getUsageSummary(
    period: AggregationPeriod = AggregationPeriod.MONTHLY,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<UsageSummaryStats> {
    const now = new Date();
    const effectiveDateFrom = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1);
    const effectiveDateTo = dateTo || now;

    // Get aggregated stats per meter type
    const queryBuilder = this.aggregationRepo
      .createQueryBuilder('ua')
      .select('ua.meterType', 'meterType')
      .addSelect('ua.unit', 'unit')
      .addSelect('SUM(CAST(ua.totalUsage AS double precision))', 'totalUsage')
      .addSelect('AVG(CAST(ua.totalUsage AS double precision))', 'avgPerTenant')
      .addSelect('MAX(CAST(ua.totalUsage AS double precision))', 'maxPerTenant')
      .addSelect('SUM(ua.eventCount)', 'totalEvents')
      .addSelect('COUNT(DISTINCT ua.tenantId)', 'tenantCount')
      .where('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
      .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
      .groupBy('ua.meterType')
      .addGroupBy('ua.unit');

    const results = await queryBuilder.getRawMany();

    const totalTenants = new Set(
      (await this.aggregationRepo
        .createQueryBuilder('ua')
        .select('DISTINCT ua.tenantId')
        .where('ua.period = :period', { period })
        .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
        .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
        .getRawMany()).map((r: { tenantId: string }) => r.tenantId)
    ).size;

    const totalEvents = results.reduce(
      (sum: number, r: Record<string, unknown>) => sum + Number(r['totalEvents'] || 0),
      0,
    );

    return {
      totalTenants,
      totalEvents,
      meterBreakdown: results.map((r: Record<string, unknown>) => ({
        meterType: r['meterType'] as MeterType,
        totalUsage: Number(r['totalUsage'] || 0),
        avgPerTenant: Number(r['avgPerTenant'] || 0),
        maxPerTenant: Number(r['maxPerTenant'] || 0),
        unit: r['unit'] as string,
        tenantCount: Number(r['tenantCount'] || 0),
      })),
      periodCovered: {
        from: effectiveDateFrom,
        to: effectiveDateTo,
      },
    };
  }

  // ============================================================================
  // Tenant Usage
  // ============================================================================

  /**
   * Get usage overview for a specific tenant
   */
  async getTenantUsageOverview(
    tenantId: string,
    period: AggregationPeriod = AggregationPeriod.MONTHLY,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<TenantUsageOverview> {
    const now = new Date();
    const effectiveDateFrom = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1);
    const effectiveDateTo = dateTo || now;

    const results = await this.aggregationRepo
      .createQueryBuilder('ua')
      .select('ua.meterType', 'meterType')
      .addSelect('ua.unit', 'unit')
      .addSelect('SUM(CAST(ua.totalUsage AS double precision))', 'totalUsage')
      .addSelect('SUM(ua.eventCount)', 'eventCount')
      .addSelect('MAX(CAST(ua.peakUsage AS double precision))', 'peakUsage')
      .addSelect('AVG(CAST(ua.averageUsage AS double precision))', 'averageUsage')
      .addSelect('MAX(ua.updatedAt)', 'lastActivity')
      .where('ua.tenantId = :tenantId', { tenantId })
      .andWhere('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
      .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
      .groupBy('ua.meterType')
      .addGroupBy('ua.unit')
      .getRawMany();

    const totalEvents = results.reduce(
      (sum: number, r: Record<string, unknown>) => sum + Number(r['eventCount'] || 0),
      0,
    );

    const lastActivity = results.reduce(
      (latest: Date | undefined, r: Record<string, unknown>) => {
        const dt = r['lastActivity'] ? new Date(r['lastActivity'] as string) : undefined;
        if (!dt) return latest;
        if (!latest) return dt;
        return dt > latest ? dt : latest;
      },
      undefined as Date | undefined,
    );

    return {
      tenantId,
      meters: results.map((r: Record<string, unknown>) => ({
        meterType: r['meterType'] as MeterType,
        totalUsage: Number(r['totalUsage'] || 0),
        unit: r['unit'] as string,
        eventCount: Number(r['eventCount'] || 0),
        peakUsage: Number(r['peakUsage'] || 0),
        averageUsage: Number(r['averageUsage'] || 0),
      })),
      totalEvents,
      lastActivity,
    };
  }

  /**
   * Get all tenants with usage data (paginated)
   */
  async getAllTenantsUsage(
    period: AggregationPeriod = AggregationPeriod.MONTHLY,
    dateFrom?: Date,
    dateTo?: Date,
    limit = 50,
    offset = 0,
  ): Promise<{ tenants: TenantUsageOverview[]; total: number }> {
    const now = new Date();
    const effectiveDateFrom = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1);
    const effectiveDateTo = dateTo || now;

    // Get distinct tenant IDs with usage data
    const tenantQuery = this.aggregationRepo
      .createQueryBuilder('ua')
      .select('DISTINCT ua.tenantId', 'tenantId')
      .addSelect('SUM(ua.eventCount)', 'totalEvents')
      .where('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
      .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
      .groupBy('ua.tenantId')
      .orderBy('"totalEvents"', 'DESC')
      .limit(limit)
      .offset(offset);

    const tenantResults = await tenantQuery.getRawMany();

    // Count total
    const countResult = await this.aggregationRepo
      .createQueryBuilder('ua')
      .select('COUNT(DISTINCT ua.tenantId)', 'count')
      .where('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
      .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
      .getRawOne();

    const total = Number(countResult?.count || 0);

    // Fetch detailed usage for each tenant
    const tenants: TenantUsageOverview[] = [];
    for (const row of tenantResults) {
      const overview = await this.getTenantUsageOverview(
        row.tenantId,
        period,
        effectiveDateFrom,
        effectiveDateTo,
      );
      tenants.push(overview);
    }

    return { tenants, total };
  }

  // ============================================================================
  // Usage Trends
  // ============================================================================

  /**
   * Get usage trend data for charts
   */
  async getUsageTrends(
    period: AggregationPeriod = AggregationPeriod.DAILY,
    meterType?: MeterType,
    tenantId?: string,
    numPeriods = 30,
  ): Promise<UsageTrendPoint[]> {
    const now = new Date();
    const startDate = this.subtractPeriods(now, period, numPeriods);

    const queryBuilder = this.aggregationRepo
      .createQueryBuilder('ua')
      .select('ua.periodStart', 'periodStart')
      .addSelect('ua.periodEnd', 'periodEnd')
      .addSelect('ua.meterType', 'meterType')
      .addSelect('ua.unit', 'unit')
      .addSelect('SUM(CAST(ua.totalUsage AS double precision))', 'totalUsage')
      .addSelect('MAX(CAST(ua.peakUsage AS double precision))', 'peakUsage')
      .addSelect('AVG(CAST(ua.averageUsage AS double precision))', 'averageUsage')
      .addSelect('SUM(ua.eventCount)', 'eventCount')
      .where('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :startDate', { startDate });

    if (meterType) {
      queryBuilder.andWhere('ua.meterType = :meterType', { meterType });
    }
    if (tenantId) {
      queryBuilder.andWhere('ua.tenantId = :tenantId', { tenantId });
    }

    queryBuilder
      .groupBy('ua.periodStart')
      .addGroupBy('ua.periodEnd')
      .addGroupBy('ua.meterType')
      .addGroupBy('ua.unit')
      .orderBy('ua.periodStart', 'ASC');

    const results = await queryBuilder.getRawMany();

    return results.map((r: Record<string, unknown>) => ({
      periodStart: new Date(r['periodStart'] as string),
      periodEnd: new Date(r['periodEnd'] as string),
      meterType: r['meterType'] as MeterType,
      totalUsage: Number(r['totalUsage'] || 0),
      peakUsage: Number(r['peakUsage'] || 0),
      averageUsage: Number(r['averageUsage'] || 0),
      eventCount: Number(r['eventCount'] || 0),
      unit: r['unit'] as string,
    }));
  }

  // ============================================================================
  // Top Tenants
  // ============================================================================

  /**
   * Get top tenants by usage for a specific meter type
   */
  async getTopTenantsByUsage(
    meterType: MeterType,
    period: AggregationPeriod = AggregationPeriod.MONTHLY,
    limit = 10,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<TopTenantUsage[]> {
    const now = new Date();
    const effectiveDateFrom = dateFrom || new Date(now.getFullYear(), now.getMonth(), 1);
    const effectiveDateTo = dateTo || now;

    const results = await this.aggregationRepo
      .createQueryBuilder('ua')
      .select('ua.tenantId', 'tenantId')
      .addSelect('ua.meterType', 'meterType')
      .addSelect('ua.unit', 'unit')
      .addSelect('SUM(CAST(ua.totalUsage AS double precision))', 'totalUsage')
      .addSelect('SUM(ua.eventCount)', 'eventCount')
      .where('ua.meterType = :meterType', { meterType })
      .andWhere('ua.period = :period', { period })
      .andWhere('ua.periodStart >= :dateFrom', { dateFrom: effectiveDateFrom })
      .andWhere('ua.periodEnd <= :dateTo', { dateTo: effectiveDateTo })
      .groupBy('ua.tenantId')
      .addGroupBy('ua.meterType')
      .addGroupBy('ua.unit')
      .orderBy('"totalUsage"', 'DESC')
      .limit(limit)
      .getRawMany();

    return results.map((r: Record<string, unknown>) => ({
      tenantId: r['tenantId'] as string,
      totalUsage: Number(r['totalUsage'] || 0),
      meterType: r['meterType'] as MeterType,
      unit: r['unit'] as string,
      eventCount: Number(r['eventCount'] || 0),
    }));
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private subtractPeriods(date: Date, period: AggregationPeriod, count: number): Date {
    const result = new Date(date);

    switch (period) {
      case AggregationPeriod.HOURLY:
        result.setHours(result.getHours() - count);
        break;
      case AggregationPeriod.DAILY:
        result.setDate(result.getDate() - count);
        break;
      case AggregationPeriod.WEEKLY:
        result.setDate(result.getDate() - count * 7);
        break;
      case AggregationPeriod.MONTHLY:
        result.setMonth(result.getMonth() - count);
        break;
      case AggregationPeriod.QUARTERLY:
        result.setMonth(result.getMonth() - count * 3);
        break;
      case AggregationPeriod.YEARLY:
        result.setFullYear(result.getFullYear() - count);
        break;
    }

    return result;
  }
}
