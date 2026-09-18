import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBoundedListRequest,
  isSpareStockSummaryRequest,
  isWorkOrderStatsRequest,
  type AiQueryReply,
  type LowStockSparePartDto,
  type LowStockSparePartsReply,
  type MaintenanceAlertDto,
  type MaintenanceAlertsReply,
  type SpareStockSummaryReply,
  type WorkOrderDto,
  type WorkOrderStatsReply,
  type WorkOrdersReply,
} from '@platform/event-contracts';
import {
  isoOrNull,
  numberOrNull,
  respondAiQuery,
  toBoundedList,
} from '../../common/nats/ai-query-responder';
import type { WorkOrder } from '../entities/work-order.entity';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';
import { GetWorkOrderStatisticsQuery } from '../queries/get-work-order-statistics.query';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';
import { ListMaintenanceScheduleAlertsQuery } from '../queries/list-maintenance-schedule-alerts.query';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';
import type { ScheduleAlert } from '../services/maintenance-schedule.service';
import type { LowStockAlert, StockSummary } from '../services/spare-part.service';
import type { WorkOrderStatistics } from '../services/work-order.service';

/** No assignee, creator, approver, checklist, materials, labor or notes cross. */
export function projectWorkOrder(row: WorkOrder): WorkOrderDto {
  return {
    id: row.id,
    workOrderCode: row.workOrderCode,
    title: row.title,
    type: row.type,
    status: row.status,
    priority: row.priority,
    assetType: row.assetType ?? null,
    assetCode: row.relatedAsset?.assetCode ?? null,
    assetName: row.relatedAsset?.assetName ?? null,
    plannedStartDate: isoOrNull(row.plannedStartDate),
    dueDate: isoOrNull(row.dueDate),
    estimatedDurationMinutes: numberOrNull(row.estimatedDurationMinutes),
    isRecurring: row.isRecurring,
  };
}

export function projectWorkOrderStats(stats: WorkOrderStatistics): WorkOrderStatsReply {
  return {
    total: stats.total,
    byStatus: { ...stats.byStatus },
    byType: { ...stats.byType },
    byPriority: { ...stats.byPriority },
    overdue: stats.overdue,
    completedOnTime: stats.completedOnTime,
    avgCompletionMinutes: Number(stats.avgCompletionTime),
    totalCost: Number(stats.totalCost),
  };
}

export function projectScheduleAlert(alert: ScheduleAlert): MaintenanceAlertDto {
  const s = alert.schedule;
  return {
    scheduleId: s.id,
    scheduleCode: s.scheduleCode,
    name: s.name,
    category: s.category,
    assetType: s.assetType ?? null,
    assetName: s.assetName ?? null,
    nextDueDate: isoOrNull(s.nextDueDate),
    daysUntilDue: alert.daysUntilDue,
    alertType: alert.alertType,
  };
}

export function projectLowStock(alert: LowStockAlert): LowStockSparePartDto {
  const p = alert.sparePart;
  return {
    sparePartId: p.id,
    code: p.code,
    name: p.name,
    partNumber: p.partNumber,
    unit: p.unit,
    currentQuantity: Number(alert.currentQuantity),
    minStock: Number(alert.minStock),
    reorderPoint: Number(alert.reorderPoint),
    deficit: Number(alert.deficit),
    leadTimeDays: numberOrNull(p.leadTimeDays),
  };
}

export function projectStockSummary(summary: StockSummary): SpareStockSummaryReply {
  return {
    totalParts: summary.totalParts,
    totalValue: Number(summary.totalValue),
    lowStockCount: summary.lowStockCount,
    outOfStockCount: summary.outOfStockCount,
    byStatus: { ...summary.byStatus },
  };
}

/** Maintenance + spare-part read surface for the farm operations specialist (FARM-MEDIUM-328). */
@Controller()
export class MaintenanceAiQueryResponder {
  private readonly logger = new Logger(MaintenanceAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS)
  listOverdueWorkOrders(@Payload() payload: unknown): Promise<AiQueryReply<WorkOrdersReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS,
      payload,
      isBoundedListRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListOverdueWorkOrdersQuery, WorkOrder[]>(
          new ListOverdueWorkOrdersQuery(req.tenantId),
        );
        return toBoundedList(rows, req.limit, projectWorkOrder);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS)
  getWorkOrderStats(@Payload() payload: unknown): Promise<AiQueryReply<WorkOrderStatsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS,
      payload,
      isWorkOrderStatsRequest,
      async (req) => {
        const stats = await this.queryBus.execute<GetWorkOrderStatisticsQuery, WorkOrderStatistics>(
          new GetWorkOrderStatisticsQuery(
            req.tenantId,
            req.fromDate ? new Date(req.fromDate) : undefined,
            req.toDate ? new Date(req.toDate) : undefined,
          ),
        );
        return projectWorkOrderStats(stats);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS)
  listMaintenanceAlerts(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<MaintenanceAlertsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS,
      payload,
      isBoundedListRequest,
      async (req) => {
        const alerts = await this.queryBus.execute<
          ListMaintenanceScheduleAlertsQuery,
          ScheduleAlert[]
        >(new ListMaintenanceScheduleAlertsQuery(req.tenantId));
        return toBoundedList(alerts, req.limit, projectScheduleAlert);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK)
  listLowStock(@Payload() payload: unknown): Promise<AiQueryReply<LowStockSparePartsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK,
      payload,
      isBoundedListRequest,
      async (req) => {
        const alerts = await this.queryBus.execute<ListLowStockAlertsQuery, LowStockAlert[]>(
          new ListLowStockAlertsQuery(req.tenantId),
        );
        return toBoundedList(alerts, req.limit, projectLowStock);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY)
  getStockSummary(@Payload() payload: unknown): Promise<AiQueryReply<SpareStockSummaryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY,
      payload,
      isSpareStockSummaryRequest,
      async (req) => {
        const summary = await this.queryBus.execute<GetStockSummaryQuery, StockSummary>(
          new GetStockSummaryQuery(req.tenantId),
        );
        return projectStockSummary(summary);
      },
    );
  }
}
