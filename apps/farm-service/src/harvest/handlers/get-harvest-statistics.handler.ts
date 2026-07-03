/**
 * GetHarvestStatisticsHandler
 *
 * Handles the GetHarvestStatisticsQuery to retrieve harvest statistics for a tenant.
 *
 * @module Harvest/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetHarvestStatisticsQuery } from '../queries/get-harvest-statistics.query';
import { HarvestRecord, HarvestRecordStatus, QualityGrade } from '../entities/harvest-record.entity';

export interface HarvestStatistics {
  tenantId: string;
  dateRange: {
    startDate: Date;
    endDate: Date;
  };
  summary: {
    totalHarvests: number;
    totalQuantityHarvested: number;
    totalBiomassKg: number;
    totalRevenue: number;
    averageWeight: number;
    averagePricePerKg: number;
  };
  byStatus: Array<{
    status: HarvestRecordStatus;
    count: number;
    totalBiomass: number;
  }>;
  byQualityGrade: Array<{
    grade: QualityGrade;
    count: number;
    totalBiomass: number;
    percentage: number;
  }>;
  byMonth: Array<{
    year: number;
    month: number;
    count: number;
    totalBiomass: number;
    totalRevenue: number;
  }>;
  trends: {
    avgBiomassPerHarvest: number;
    avgQuantityPerHarvest: number;
    harvestsPerMonth: number;
  };
}

@Injectable()
@QueryHandler(GetHarvestStatisticsQuery)
export class GetHarvestStatisticsHandler implements IQueryHandler<GetHarvestStatisticsQuery, HarvestStatistics> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHarvestStatisticsQuery): Promise<HarvestStatistics> {
    const { tenantId, dateRange } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Get all harvests in date range
      const harvests = await queryRunner.manager
        .createQueryBuilder(HarvestRecord, 'harvest')
        .where('harvest.tenantId = :tenantId', { tenantId })
        .andWhere('harvest.harvestDate >= :startDate', { startDate: dateRange.startDate })
        .andWhere('harvest.harvestDate <= :endDate', { endDate: dateRange.endDate })
        .andWhere('harvest.status != :cancelledStatus', { cancelledStatus: HarvestRecordStatus.CANCELLED })
        .getMany();

      // Calculate summary statistics
      const totalHarvests = harvests.length;
      const totalQuantityHarvested = harvests.reduce((sum, h) => sum + h.quantityHarvested, 0);
      const totalBiomassKg = harvests.reduce((sum, h) => sum + Number(h.totalBiomass), 0);
      const totalRevenue = harvests.reduce((sum, h) => sum + Number(h.totalRevenue || 0), 0);
      const averageWeight = totalHarvests > 0
        ? harvests.reduce((sum, h) => sum + Number(h.averageWeight), 0) / totalHarvests
        : 0;
      const averagePricePerKg = totalBiomassKg > 0 ? totalRevenue / totalBiomassKg : 0;

      // Group by status
      const statusMap = new Map<HarvestRecordStatus, { count: number; totalBiomass: number }>();
      harvests.forEach(h => {
        const existing = statusMap.get(h.status) || { count: 0, totalBiomass: 0 };
        statusMap.set(h.status, {
          count: existing.count + 1,
          totalBiomass: existing.totalBiomass + Number(h.totalBiomass),
        });
      });

      const byStatus = Array.from(statusMap.entries()).map(([status, data]) => ({
        status,
        count: data.count,
        totalBiomass: data.totalBiomass,
      }));

      // Group by quality grade
      const gradeMap = new Map<QualityGrade, { count: number; totalBiomass: number }>();
      harvests.forEach(h => {
        const existing = gradeMap.get(h.qualityGrade) || { count: 0, totalBiomass: 0 };
        gradeMap.set(h.qualityGrade, {
          count: existing.count + 1,
          totalBiomass: existing.totalBiomass + Number(h.totalBiomass),
        });
      });

      const byQualityGrade = Array.from(gradeMap.entries()).map(([grade, data]) => ({
        grade,
        count: data.count,
        totalBiomass: data.totalBiomass,
        percentage: totalHarvests > 0 ? (data.count / totalHarvests) * 100 : 0,
      }));

      // Group by month
      const monthMap = new Map<string, { year: number; month: number; count: number; totalBiomass: number; totalRevenue: number }>();
      harvests.forEach(h => {
        const date = new Date(h.harvestDate);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const key = `${year}-${month}`;
        const existing = monthMap.get(key) || { year, month, count: 0, totalBiomass: 0, totalRevenue: 0 };
        monthMap.set(key, {
          year,
          month,
          count: existing.count + 1,
          totalBiomass: existing.totalBiomass + Number(h.totalBiomass),
          totalRevenue: existing.totalRevenue + Number(h.totalRevenue || 0),
        });
      });

      const byMonth = Array.from(monthMap.values()).sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      });

      // Calculate trends
      const monthsInRange = Math.max(1,
        (dateRange.endDate.getTime() - dateRange.startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
      );
      const avgBiomassPerHarvest = totalHarvests > 0 ? totalBiomassKg / totalHarvests : 0;
      const avgQuantityPerHarvest = totalHarvests > 0 ? totalQuantityHarvested / totalHarvests : 0;
      const harvestsPerMonth = totalHarvests / monthsInRange;

      return {
        tenantId,
        dateRange,
        summary: {
          totalHarvests,
          totalQuantityHarvested,
          totalBiomassKg,
          totalRevenue,
          averageWeight,
          averagePricePerKg,
        },
        byStatus,
        byQualityGrade,
        byMonth,
        trends: {
          avgBiomassPerHarvest,
          avgQuantityPerHarvest,
          harvestsPerMonth,
        },
      };
    });
  }
}
