import { collaborator } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import { getQueryHandlerMetadata, type QueryBus } from '@platform/cqrs';
import type { OutboxPublisher } from '@platform/outbox';

import { GetBatchPerformanceHandler } from '../../../../apps/farm-service/src/batch/query-handlers/get-batch-performance.handler';
import { GetMortalityByCauseHandler } from '../../../../apps/farm-service/src/batch/query-handlers/get-mortality-by-cause.handler';
import { GetTransfersSummaryHandler } from '../../../../apps/farm-service/src/batch/query-handlers/get-transfers-summary.handler';
import { BatchAiQueryResponder } from '../../../../apps/farm-service/src/batch/responders/batch-ai-query.responder';
import { GetBatchOverviewResponder } from '../../../../apps/farm-service/src/batch/responders/get-batch-overview.responder';
import { BatchCostCalculatorService } from '../../../../apps/farm-service/src/batch/services/batch-cost-calculator.service';
import type { FarmAiResponder } from '../../../../apps/farm-service/src/common/tenant-boundary/farm-ai-responder';
import { ListEquipmentHandler } from '../../../../apps/farm-service/src/equipment/handlers/list-equipment.handler';
import { ListFeederCalibrationsHandler } from '../../../../apps/farm-service/src/equipment/handlers/list-feeder-calibrations.handler';
import { EquipmentAiQueryResponder } from '../../../../apps/farm-service/src/equipment/responders/equipment-ai-query.responder';
import { GetFarmStockInventoryHandler } from '../../../../apps/farm-service/src/farm-stock/handlers/get-farm-stock-inventory.handler';
import { FarmStockAiQueryResponder } from '../../../../apps/farm-service/src/farm-stock/responders/farm-stock-ai-query.responder';
import { ListFeedingProtocolsHandler } from '../../../../apps/farm-service/src/feed/handlers/list-feeding-protocols.handler';
import { GetDailyFeedingPlanHandler } from '../../../../apps/farm-service/src/feeding/query-handlers/get-daily-feeding-plan.handler';
import { GetFeedingSummaryHandler } from '../../../../apps/farm-service/src/feeding/query-handlers/get-feeding-summary.handler';
import { GetSiteFeedConsumptionHandler } from '../../../../apps/farm-service/src/feeding/query-handlers/get-site-feed-consumption.handler';
import { FeedingAiQueryResponder } from '../../../../apps/farm-service/src/feeding/responders/feeding-ai-query.responder';
import { GetFeedingOverviewResponder } from '../../../../apps/farm-service/src/feeding/responders/get-feeding-overview.responder';
import { GetFinanceBatchTotalsHandler } from '../../../../apps/farm-service/src/finance/query-handlers/get-finance-batch-totals.handler';
import { GetFinanceSummaryHandler } from '../../../../apps/farm-service/src/finance/query-handlers/get-finance-summary.handler';
import { FinanceAiQueryResponder } from '../../../../apps/farm-service/src/finance/responders/finance-ai-query.responder';
import { ComputedRuleEvaluator } from '../../../../apps/farm-service/src/finance/services/computed-rule-evaluator';
import { FinanceLedgerReader } from '../../../../apps/farm-service/src/finance/services/finance-ledger-reader';
import { GetHealthEventStatsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/get-health-event-stats.handler';
import { ListCriticalHealthEventsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-critical-health-events.handler';
import { ListHealthEventsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-health-events.handler';
import { ListLiceCountsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-lice-counts.handler';
import { ListOverdueFollowUpsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-overdue-follow-ups.handler';
import { ListTreatmentApplicationsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-treatment-applications.handler';
import { ListWelfareAssessmentsHandler } from '../../../../apps/farm-service/src/fish-health/handlers/list-welfare-assessments.handler';
import { FishHealthAiQueryResponder } from '../../../../apps/farm-service/src/fish-health/responders/fish-health-ai-query.responder';
import { BatchHarvestEligibilityService } from '../../../../apps/farm-service/src/fish-health/services/batch-harvest-eligibility.service';
import { GetGrowthAnalysisHandler } from '../../../../apps/farm-service/src/growth/query-handlers/get-growth-analysis.handler';
import { GetGrowthMeasurementsHandler } from '../../../../apps/farm-service/src/growth/query-handlers/get-growth-measurements.handler';
import { GrowthAiQueryResponder } from '../../../../apps/farm-service/src/growth/responders/growth-ai-query.responder';
import { GetHarvestPlanStatsHandler } from '../../../../apps/farm-service/src/harvest/handlers/get-harvest-plan-stats.handler';
import { ListOverdueHarvestPlansHandler } from '../../../../apps/farm-service/src/harvest/handlers/list-overdue-harvest-plans.handler';
import { ListUpcomingHarvestPlansHandler } from '../../../../apps/farm-service/src/harvest/handlers/list-upcoming-harvest-plans.handler';
import { GetHarvestOverviewResponder } from '../../../../apps/farm-service/src/harvest/responders/get-harvest-overview.responder';
import { HarvestAiQueryResponder } from '../../../../apps/farm-service/src/harvest/responders/harvest-ai-query.responder';
import { GetStockSummaryHandler } from '../../../../apps/farm-service/src/maintenance/handlers/get-stock-summary.handler';
import { GetWorkOrderStatisticsHandler } from '../../../../apps/farm-service/src/maintenance/handlers/get-work-order-statistics.handler';
import { ListLowStockAlertsHandler } from '../../../../apps/farm-service/src/maintenance/handlers/list-low-stock-alerts.handler';
import { ListMaintenanceScheduleAlertsHandler } from '../../../../apps/farm-service/src/maintenance/handlers/list-maintenance-schedule-alerts.handler';
import { ListOverdueWorkOrdersHandler } from '../../../../apps/farm-service/src/maintenance/handlers/list-overdue-work-orders.handler';
import { MaintenanceAiQueryResponder } from '../../../../apps/farm-service/src/maintenance/responders/maintenance-ai-query.responder';
import { GetBiomassReportByPeriodHandler } from '../../../../apps/farm-service/src/regulatory/handlers/get-biomass-report-by-period.handler';
import { ListRegulatoryReportsHandler } from '../../../../apps/farm-service/src/regulatory/handlers/list-regulatory-reports.handler';
import { RegulatoryAiQueryResponder } from '../../../../apps/farm-service/src/regulatory/responders/regulatory-ai-query.responder';
import { ListSpeciesHandler } from '../../../../apps/farm-service/src/species/handlers/list-species.handler';
import { SpeciesAiQueryResponder } from '../../../../apps/farm-service/src/species/responders/species-ai-query.responder';
import { GetTankCapacityHandler } from '../../../../apps/farm-service/src/tank/handlers/get-tank-capacity.handler';
import { GetTankRegistryResponder } from '../../../../apps/farm-service/src/tank/responders/get-tank-registry.responder';
import { TankAiQueryResponder } from '../../../../apps/farm-service/src/tank/responders/tank-ai-query.responder';
import { GetTaskStatsHandler } from '../../../../apps/farm-service/src/task/handlers/get-task-stats.handler';
import { ListTodaysTasksHandler } from '../../../../apps/farm-service/src/task/handlers/list-todays-tasks.handler';
import { CreateTaskResponder } from '../../../../apps/farm-service/src/task/responders/create-task.responder';
import { TaskAiQueryResponder } from '../../../../apps/farm-service/src/task/responders/task-ai-query.responder';
import { TaskCreator } from '../../../../apps/farm-service/src/task/services/task-creator';
import { GetSystemWaterQualityStatisticsHandler } from '../../../../apps/farm-service/src/water-quality/query-handlers/get-system-water-quality-statistics.handler';
import { GetTankWaterQualityStatisticsHandler } from '../../../../apps/farm-service/src/water-quality/query-handlers/get-tank-water-quality-statistics.handler';
import { ListCriticalWaterQualityHandler } from '../../../../apps/farm-service/src/water-quality/query-handlers/list-critical-water-quality.handler';
import { ListParameterConfigsHandler } from '../../../../apps/farm-service/src/water-quality/query-handlers/list-parameter-configs.handler';
import { ListWaterQualityHandler } from '../../../../apps/farm-service/src/water-quality/query-handlers/list-water-quality.handler';
import { GetWaterQualityOverviewResponder } from '../../../../apps/farm-service/src/water-quality/responders/get-water-quality-overview.responder';
import { WaterQualityAiQueryResponder } from '../../../../apps/farm-service/src/water-quality/responders/water-quality-ai-query.responder';

/** A query handler instance: what the bus routes a query to. */
interface QueryHandlerInstance {
  execute(query: object): Promise<unknown>;
}

/** Every farm AI responder, wired as production wires them. */
export interface FarmAiResponders {
  readonly responders: readonly object[];
  /** The cost collaborator behind get_batch_performance (a spec spies on it). */
  readonly costCalculator: BatchCostCalculatorService;
}

/**
 * Build EVERY farm-service responder an AI subject reaches, over the REAL
 * query handlers, sharing one responder skeleton.
 *
 * WHY every one (V-T1a-6): the red-team's table-driven case sends tenant B's
 * ids to each subject; a responder left out here would make its subject
 * unreachable, which the spec's own coverage check refuses.
 *
 * The query bus routes by each handler's @QueryHandler metadata, like the
 * production bus — a hand-written query→handler map could point elsewhere.
 */
export function buildFarmAiResponders(skeleton: FarmAiResponder): FarmAiResponders {
  const costCalculator = new BatchCostCalculatorService(
    collaborator<ConfigService>({ get: jest.fn(() => undefined) }, 'ConfigService'),
  );
  const ledgerReader = new FinanceLedgerReader(new ComputedRuleEvaluator());
  const handlers: QueryHandlerInstance[] = [
    new GetBatchPerformanceHandler(costCalculator),
    new GetMortalityByCauseHandler(),
    new GetTransfersSummaryHandler(),
    new ListEquipmentHandler(),
    new ListFeederCalibrationsHandler(),
    new GetFarmStockInventoryHandler(),
    new GetDailyFeedingPlanHandler(),
    new GetFeedingSummaryHandler(),
    new GetSiteFeedConsumptionHandler(),
    new ListFeedingProtocolsHandler(),
    new GetFinanceBatchTotalsHandler(ledgerReader),
    new GetFinanceSummaryHandler(ledgerReader),
    new GetHealthEventStatsHandler(),
    new ListCriticalHealthEventsHandler(),
    new ListHealthEventsHandler(),
    new ListLiceCountsHandler(),
    new ListOverdueFollowUpsHandler(),
    new ListTreatmentApplicationsHandler(),
    new ListWelfareAssessmentsHandler(),
    new GetGrowthAnalysisHandler(),
    new GetGrowthMeasurementsHandler(),
    new GetHarvestPlanStatsHandler(),
    new ListOverdueHarvestPlansHandler(),
    new ListUpcomingHarvestPlansHandler(),
    new GetStockSummaryHandler(),
    new GetWorkOrderStatisticsHandler(),
    new ListLowStockAlertsHandler(),
    new ListMaintenanceScheduleAlertsHandler(),
    new ListOverdueWorkOrdersHandler(),
    new GetBiomassReportByPeriodHandler(),
    new ListRegulatoryReportsHandler(),
    new ListSpeciesHandler(),
    new GetTankCapacityHandler(),
    new GetTaskStatsHandler(),
    new ListTodaysTasksHandler(),
    new GetSystemWaterQualityStatisticsHandler(),
    new GetTankWaterQualityStatisticsHandler(),
    new ListCriticalWaterQualityHandler(),
    new ListParameterConfigsHandler(),
    new ListWaterQualityHandler(),
  ];
  const routes = new Map<object, QueryHandlerInstance>();
  for (const handler of handlers) {
    const metadata = getQueryHandlerMetadata(handler.constructor);
    if (metadata === undefined) throw new Error(`${handler.constructor.name} has no @QueryHandler`);
    routes.set(metadata.query, handler);
  }
  // A plain jest.Mock: QueryBus.execute is generic in its result, decided per query at runtime.
  const execute: jest.Mock = jest.fn(async (query: object): Promise<unknown> => {
    const handler = routes.get(query.constructor);
    if (handler === undefined) throw new Error(`no handler for ${query.constructor.name}`);
    return handler.execute(query);
  });
  const queryBus = collaborator<QueryBus>({ execute }, 'QueryBus');
  const taskCreator = new TaskCreator(
    collaborator<OutboxPublisher>(
      { enqueue: jest.fn().mockResolvedValue(undefined) },
      'OutboxPublisher',
    ),
  );

  return {
    costCalculator,
    responders: [
      new BatchAiQueryResponder(skeleton, queryBus),
      new EquipmentAiQueryResponder(skeleton, queryBus),
      new FarmStockAiQueryResponder(skeleton, queryBus),
      new FeedingAiQueryResponder(skeleton, queryBus),
      new FinanceAiQueryResponder(skeleton, queryBus),
      new FishHealthAiQueryResponder(skeleton, queryBus, new BatchHarvestEligibilityService()),
      new GrowthAiQueryResponder(skeleton, queryBus),
      new HarvestAiQueryResponder(skeleton, queryBus),
      new MaintenanceAiQueryResponder(skeleton, queryBus),
      new RegulatoryAiQueryResponder(skeleton, queryBus),
      new SpeciesAiQueryResponder(skeleton, queryBus),
      new TankAiQueryResponder(skeleton, queryBus),
      new TaskAiQueryResponder(skeleton, queryBus),
      new WaterQualityAiQueryResponder(skeleton, queryBus),
      new GetBatchOverviewResponder(skeleton),
      new GetFeedingOverviewResponder(skeleton),
      new GetHarvestOverviewResponder(skeleton),
      new GetTankRegistryResponder(skeleton),
      new GetWaterQualityOverviewResponder(skeleton),
      new CreateTaskResponder(skeleton, taskCreator),
    ],
  };
}
