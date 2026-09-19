import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { CreateTaskTool } from './create-task.tool';
import { GetFarmTanksTool } from './get-farm-tanks.tool';
import { GetFarmBatchesTool } from './get-farm-batches.tool';
import { GetFarmWaterQualityTool } from './get-farm-water-quality.tool';
import { GetFarmHarvestTool } from './get-farm-harvest.tool';
import { GetFarmFeedingTool } from './get-farm-feeding.tool';
import {
  CheckBatchHarvestEligibilityTool,
  GetFishHealthStatsTool,
  GetSystemWaterQualityStatsTool,
  GetTankWaterQualityStatsTool,
  GetWaterQualityHistoryTool,
  GetWaterQualityThresholdsTool,
  ListCriticalHealthEventsTool,
  ListCriticalWaterQualityTool,
  ListHealthEventsTool,
  ListLiceCountsTool,
  ListOverdueHealthFollowUpsTool,
  ListTreatmentApplicationsTool,
  ListWelfareAssessmentsTool,
} from './water-health';
import {
  GetBatchPerformanceTool,
  GetBiomassReportTool,
  GetDailyFeedingPlanTool,
  GetFeedingSummaryTool,
  GetFinanceBatchTotalsTool,
  GetFinanceSummaryTool,
  GetGrowthAnalysisTool,
  GetHarvestPlanStatsTool,
  GetMortalityByCauseTool,
  GetSiteFeedConsumptionTool,
  GetTankCapacityTool,
  GetTransfersSummaryTool,
  ListFeedingProtocolsTool,
  ListGrowthMeasurementsTool,
  ListHarvestPlansTool,
  ListRegulatoryReportsTool,
  ListSpeciesTool,
} from './production';
import {
  GetFarmStockInventoryTool,
  GetSpareStockSummaryTool,
  GetTaskStatsTool,
  GetWorkOrderStatsTool,
  ListEquipmentTool,
  ListFeederCalibrationsTool,
  ListLowStockSparePartsTool,
  ListMaintenanceAlertsTool,
  ListOverdueWorkOrdersTool,
  ListTodaysTasksTool,
} from './operations';

const TOOLS = [
  CreateTaskTool,
  GetFarmTanksTool,
  GetFarmBatchesTool,
  GetFarmWaterQualityTool,
  GetFarmHarvestTool,
  GetFarmFeedingTool,
  // farm-water-health specialist (FARM-MEDIUM-328): contract farm-ai-queries
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
  // farm-production specialist (FARM-MEDIUM-328)
  GetBatchPerformanceTool,
  GetGrowthAnalysisTool,
  ListGrowthMeasurementsTool,
  GetMortalityByCauseTool,
  GetTransfersSummaryTool,
  ListSpeciesTool,
  GetTankCapacityTool,
  GetDailyFeedingPlanTool,
  GetFeedingSummaryTool,
  GetSiteFeedConsumptionTool,
  ListFeedingProtocolsTool,
  ListHarvestPlansTool,
  GetHarvestPlanStatsTool,
  GetBiomassReportTool,
  ListRegulatoryReportsTool,
  GetFinanceSummaryTool,
  GetFinanceBatchTotalsTool,
  // farm-operations specialist (FARM-MEDIUM-328)
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
 * Farm tools (read surface + the create_task actuation). They reach farm-service over NATS request-reply,
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
