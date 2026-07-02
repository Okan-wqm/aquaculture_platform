/**
 * Get Work Order Statistics Query Handler — fail-closed tenant boundary.
 * Loads the tenant's work orders on the asserted connection and aggregates.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderType,
  WorkOrderPriority,
} from '../entities/work-order.entity';
import { WorkOrderStatistics } from '../services/work-order.service';
import { GetWorkOrderStatisticsQuery } from '../queries/get-work-order-statistics.query';

@QueryHandler(GetWorkOrderStatisticsQuery)
export class GetWorkOrderStatisticsHandler
  implements IQueryHandler<GetWorkOrderStatisticsQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWorkOrderStatisticsQuery): Promise<WorkOrderStatistics> {
    const { tenantId, dateFrom, dateTo } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(WorkOrder, 'wo')
        .where('wo.tenantId = :tenantId', { tenantId });

      if (dateFrom) {
        qb.andWhere('wo.createdAt >= :dateFrom', { dateFrom });
      }
      if (dateTo) {
        qb.andWhere('wo.createdAt <= :dateTo', { dateTo });
      }

      const workOrders = await qb.getMany();

      const stats: WorkOrderStatistics = {
        total: workOrders.length,
        byStatus: {} as Record<WorkOrderStatus, number>,
        byType: {} as Record<WorkOrderType, number>,
        byPriority: {} as Record<WorkOrderPriority, number>,
        overdue: 0,
        completedOnTime: 0,
        avgCompletionTime: 0,
        totalCost: 0,
      };

      Object.values(WorkOrderStatus).forEach((s) => (stats.byStatus[s] = 0));
      Object.values(WorkOrderType).forEach((t) => (stats.byType[t] = 0));
      Object.values(WorkOrderPriority).forEach((p) => (stats.byPriority[p] = 0));

      let totalCompletionTime = 0;
      let completedCount = 0;

      for (const wo of workOrders) {
        stats.byStatus[wo.status]++;
        stats.byType[wo.type]++;
        stats.byPriority[wo.priority]++;

        if (wo.isOverdue()) {
          stats.overdue++;
        }

        if (wo.status === WorkOrderStatus.COMPLETED || wo.status === WorkOrderStatus.VERIFIED) {
          if (wo.completedAt && wo.dueDate && wo.completedAt <= wo.dueDate) {
            stats.completedOnTime++;
          }
          if (wo.actualDurationMinutes) {
            totalCompletionTime += wo.actualDurationMinutes;
            completedCount++;
          }
        }

        if (wo.costSummary?.totalCost) {
          stats.totalCost += Number(wo.costSummary.totalCost);
        }
      }

      if (completedCount > 0) {
        stats.avgCompletionTime = totalCompletionTime / completedCount;
      }

      return stats;
    });
  }
}
