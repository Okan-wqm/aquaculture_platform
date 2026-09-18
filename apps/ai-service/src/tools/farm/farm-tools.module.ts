import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { CreateTaskTool } from './create-task.tool';
import { GetFarmTanksTool } from './get-farm-tanks.tool';
import { GetFarmBatchesTool } from './get-farm-batches.tool';
import { GetFarmWaterQualityTool } from './get-farm-water-quality.tool';
import { GetFarmHarvestTool } from './get-farm-harvest.tool';
import { GetFarmFeedingTool } from './get-farm-feeding.tool';

// PR-3: Water & Health specialist read-only query tools (farm-ai-query).
import { GetTankWaterQualityStatsTool } from './water-health/get-tank-water-quality-stats.tool';
import { GetSystemWaterQualityStatsTool } from './water-health/get-system-water-quality-stats.tool';
import { GetWaterQualityHistoryTool } from './water-health/get-water-quality-history.tool';
import { ListCriticalWaterQualityTool } from './water-health/list-critical-water-quality.tool';
import { GetWaterQualityThresholdsTool } from './water-health/get-water-quality-thresholds.tool';
import { GetFishHealthStatsTool } from './water-health/get-fish-health-stats.tool';
import { ListHealthEventsTool } from './water-health/list-health-events.tool';
import { ListCriticalHealthEventsTool } from './water-health/list-critical-health-events.tool';
import { ListOverdueHealthFollowUpsTool } from './water-health/list-overdue-health-follow-ups.tool';
import { ListLiceCountsTool } from './water-health/list-lice-counts.tool';
import { ListTreatmentApplicationsTool } from './water-health/list-treatment-applications.tool';
import { ListWelfareAssessmentsTool } from './water-health/list-welfare-assessments.tool';
import { CheckBatchHarvestEligibilityTool } from './water-health/check-batch-harvest-eligibility.tool';

// PR-4: Production specialist read-only query tools (farm-ai-query).
import { GetBatchPerformanceTool } from './production/get-batch-performance.tool';
import { GetGrowthAnalysisTool } from './production/get-growth-analysis.tool';
import { ListGrowthMeasurementsTool } from './production/list-growth-measurements.tool';
import { GetMortalityByCauseTool } from './production/get-mortality-by-cause.tool';
import { GetTransfersSummaryTool } from './production/get-transfers-summary.tool';
import { GetDailyFeedingPlanTool } from './production/get-daily-feeding-plan.tool';
import { GetFeedingSummaryTool } from './production/get-feeding-summary.tool';
import { GetSiteFeedConsumptionTool } from './production/get-site-feed-consumption.tool';
import { ListFeedingProtocolsTool } from './production/list-feeding-protocols.tool';
import { ListSpeciesTool } from './production/list-species.tool';
import { ListHarvestPlansTool } from './production/list-harvest-plans.tool';
import { GetHarvestPlanStatsTool } from './production/get-harvest-plan-stats.tool';
import { GetBiomassReportTool } from './production/get-biomass-report.tool';
import { ListRegulatoryReportsTool } from './production/list-regulatory-reports.tool';
import { GetFinanceSummaryTool } from './production/get-finance-summary.tool';
import { GetFinanceBatchTotalsTool } from './production/get-finance-batch-totals.tool';

// PR-5: Operations specialist read-only query tools (farm-ai-query) —
// get_tank_capacity lives here per the program plan but is shared with the
// Production specialist bundle.
import { GetTankCapacityTool } from './operations/get-tank-capacity.tool';
import { ListEquipmentTool } from './operations/list-equipment.tool';
import { ListFeederCalibrationsTool } from './operations/list-feeder-calibrations.tool';
import { ListOverdueWorkOrdersTool } from './operations/list-overdue-work-orders.tool';
import { GetWorkOrderStatsTool } from './operations/get-work-order-stats.tool';
import { ListMaintenanceAlertsTool } from './operations/list-maintenance-alerts.tool';
import { ListLowStockSparePartsTool } from './operations/list-low-stock-spare-parts.tool';
import { GetSpareStockSummaryTool } from './operations/get-spare-stock-summary.tool';
import { GetFarmStockInventoryTool } from './operations/get-farm-stock-inventory.tool';
import { ListTodaysTasksTool } from './operations/list-todays-tasks.tool';
import { GetTaskStatsTool } from './operations/get-task-stats.tool';

const TOOLS = [
  CreateTaskTool,
  GetFarmTanksTool,
  GetFarmBatchesTool,
  GetFarmWaterQualityTool,
  GetFarmHarvestTool,
  GetFarmFeedingTool,
  // PR-3 Water & Health specialist (farm-ai-query contract).
  GetTankWaterQualityStatsTool,
  GetSystemWaterQualityStatsTool,
  GetWaterQualityHistoryTool,
  ListCriticalWaterQualityTool,
  GetWaterQualityThresholdsTool,
  GetFishHealthStatsTool,
  ListHealthEventsTool,
  ListCriticalHealthEventsTool,
  ListOverdueHealthFollowUpsTool,
  ListLiceCountsTool,
  ListTreatmentApplicationsTool,
  ListWelfareAssessmentsTool,
  CheckBatchHarvestEligibilityTool,
  // PR-4 Production specialist (farm-ai-query contract).
  GetBatchPerformanceTool,
  GetGrowthAnalysisTool,
  ListGrowthMeasurementsTool,
  GetMortalityByCauseTool,
  GetTransfersSummaryTool,
  GetDailyFeedingPlanTool,
  GetFeedingSummaryTool,
  GetSiteFeedConsumptionTool,
  ListFeedingProtocolsTool,
  ListSpeciesTool,
  ListHarvestPlansTool,
  GetHarvestPlanStatsTool,
  GetBiomassReportTool,
  ListRegulatoryReportsTool,
  GetFinanceSummaryTool,
  GetFinanceBatchTotalsTool,
  // PR-5 Operations specialist (farm-ai-query contract).
  GetTankCapacityTool,
  ListEquipmentTool,
  ListFeederCalibrationsTool,
  ListOverdueWorkOrdersTool,
  GetWorkOrderStatsTool,
  ListMaintenanceAlertsTool,
  ListLowStockSparePartsTool,
  GetSpareStockSummaryTool,
  GetFarmStockInventoryTool,
  ListTodaysTasksTool,
  GetTaskStatsTool,
];

/**
 * Farm actuation tools. The tools reach farm-service over NATS request-reply,
 * so this module registers a NATS_SERVICE client (shared cert-identity factory,
 * ADR-015). Tool registration itself is automatic — ToolRegistryService
 * discovers every @Tool()-decorated provider via DiscoveryService — so listing
 * the classes as providers is the complete registration.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'ai-service' },
      },
    ]),
  ],
  providers: [...TOOLS],
  exports: [...TOOLS],
})
export class FarmToolsModule {}
