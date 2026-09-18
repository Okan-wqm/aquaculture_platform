/**
 * Maintenance farm-AI read-only NATS responder (PR-5, Operations
 * specialist). Five `request.farm.ai.*` subjects backed EXCLUSIVELY by the
 * maintenance module's existing tenant-scoped CQRS query handlers via
 * QueryBus — no direct DB access, no commands, PII-free projections (see
 * ./projections.ts). Envelope + validation plumbing lives in
 * common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isLowStockPartsRequest,
  isMaintenanceScheduleAlertsRequest,
  isOverdueWorkOrdersRequest,
  isStockSummaryRequest,
  isWorkOrderStatsRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';
import { GetWorkOrderStatisticsQuery } from '../queries/get-work-order-statistics.query';
import { ListMaintenanceScheduleAlertsQuery } from '../queries/list-maintenance-schedule-alerts.query';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';
import { WorkOrder } from '../entities/work-order.entity';
import {
  LowStockAlert,
  StockSummary,
} from '../services/spare-part.service';
import { ScheduleAlert } from '../services/maintenance-schedule.service';
import { WorkOrderStatistics } from '../services/work-order.service';
import {
  LowStockAlertDto,
  ScheduleAlertDto,
  StockSummaryDto,
  WorkOrderDto,
  WorkOrderStatsDto,
  projectLowStockAlert,
  projectScheduleAlert,
  projectStockSummary,
  projectWorkOrder,
  projectWorkOrderStats,
} from './projections';

@Controller()
export class MaintenanceAiQueryResponder {
  private readonly logger = new Logger(MaintenanceAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS)
  async overdueWorkOrders(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<WorkOrderDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isOverdueWorkOrdersRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<ListOverdueWorkOrdersQuery, WorkOrder[]>(
            new ListOverdueWorkOrdersQuery(req.tenantId),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectWorkOrder,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS)
  async workOrderStats(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<WorkOrderStatsDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isWorkOrderStatsRequest,
      async (req) =>
        projectWorkOrderStats(
          await this.queryBus.execute<GetWorkOrderStatisticsQuery, WorkOrderStatistics>(
            new GetWorkOrderStatisticsQuery(
              req.tenantId,
              req.fromDate ? new Date(req.fromDate) : undefined,
              req.toDate ? new Date(req.toDate) : undefined,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS)
  async scheduleAlerts(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<ScheduleAlertDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isMaintenanceScheduleAlertsRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<
            ListMaintenanceScheduleAlertsQuery,
            ScheduleAlert[]
          >(new ListMaintenanceScheduleAlertsQuery(req.tenantId)),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectScheduleAlert,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK)
  async lowStock(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<LowStockAlertDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isLowStockPartsRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<ListLowStockAlertsQuery, LowStockAlert[]>(
            new ListLowStockAlertsQuery(req.tenantId),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectLowStockAlert,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY)
  async stockSummary(@Payload() payload: unknown): Promise<AiQueryReply<StockSummaryDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isStockSummaryRequest,
      async (req) =>
        projectStockSummary(
          await this.queryBus.execute<GetStockSummaryQuery, StockSummary>(
            new GetStockSummaryQuery(req.tenantId),
          ),
        ),
    );
  }
}
