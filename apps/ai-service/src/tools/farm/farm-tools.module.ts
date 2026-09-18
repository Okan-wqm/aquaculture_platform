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
