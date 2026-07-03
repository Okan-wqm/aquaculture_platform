/**
 * Get Maintenance Compliance Report Query Handler — fail-closed tenant boundary.
 * Loads the tenant's schedules on the asserted connection and aggregates.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
  MaintenanceCategory,
} from '../entities/maintenance-schedule.entity';
import { ComplianceReport } from '../services/maintenance-schedule.service';
import { GetMaintenanceComplianceReportQuery } from '../queries/get-maintenance-compliance-report.query';

@QueryHandler(GetMaintenanceComplianceReportQuery)
export class GetMaintenanceComplianceReportHandler
  implements IQueryHandler<GetMaintenanceComplianceReportQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMaintenanceComplianceReportQuery): Promise<ComplianceReport> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const schedules = await queryRunner.manager.find(MaintenanceSchedule, {
        where: { tenantId },
      });

      const report: ComplianceReport = {
        totalSchedules: schedules.length,
        activeSchedules: 0,
        overdueSchedules: 0,
        avgComplianceRate: 0,
        byCategory: {} as Record<MaintenanceCategory, { total: number; complianceRate: number }>,
        byAssetType: {} as Record<string, { total: number; complianceRate: number }>,
      };

      Object.values(MaintenanceCategory).forEach((cat) => {
        report.byCategory[cat] = { total: 0, complianceRate: 0 };
      });

      let totalComplianceRate = 0;
      let schedulesWithMetrics = 0;

      for (const schedule of schedules) {
        if (schedule.status === MaintenanceScheduleStatus.ACTIVE) {
          report.activeSchedules++;
          if (schedule.isOverdue()) {
            report.overdueSchedules++;
          }
        }

        report.byCategory[schedule.category].total++;
        if (schedule.metrics?.complianceRate) {
          report.byCategory[schedule.category].complianceRate += schedule.metrics.complianceRate;
        }

        if (schedule.assetType) {
          if (!report.byAssetType[schedule.assetType]) {
            report.byAssetType[schedule.assetType] = { total: 0, complianceRate: 0 };
          }
          const assetTypeData = report.byAssetType[schedule.assetType];
          if (assetTypeData) {
            assetTypeData.total++;
            if (schedule.metrics?.complianceRate) {
              assetTypeData.complianceRate += schedule.metrics.complianceRate;
            }
          }
        }

        if (schedule.metrics?.complianceRate) {
          totalComplianceRate += schedule.metrics.complianceRate;
          schedulesWithMetrics++;
        }
      }

      if (schedulesWithMetrics > 0) {
        report.avgComplianceRate = totalComplianceRate / schedulesWithMetrics;
      }

      for (const cat of Object.values(MaintenanceCategory)) {
        if (report.byCategory[cat].total > 0) {
          report.byCategory[cat].complianceRate /= report.byCategory[cat].total;
        }
      }

      for (const assetType of Object.keys(report.byAssetType)) {
        const assetData = report.byAssetType[assetType];
        if (assetData && assetData.total > 0) {
          assetData.complianceRate /= assetData.total;
        }
      }

      return report;
    });
  }
}
