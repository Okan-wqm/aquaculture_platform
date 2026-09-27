import { Module } from '@nestjs/common';
import { CalculateOxygenBudgetTool } from './calculate-oxygen-budget.tool';
import { CalculateCarryingCapacityTool } from './calculate-carrying-capacity.tool';
import { CalculateGrowthMetricsTool } from './calculate-growth-metrics.tool';
import { PredictFeedingImpactTool } from './predict-feeding-impact.tool';

const TOOLS = [
  CalculateOxygenBudgetTool,
  CalculateCarryingCapacityTool,
  CalculateGrowthMetricsTool,
  PredictFeedingImpactTool,
];

/**
 * Pure aquaculture arithmetic (FARM-LOW-329) — oxygen budget, carrying
 * capacity, growth metrics and feeding impact — over
 * @platform/aquaculture-engines, the same engines the MCP farm-management
 * tools wrap. No NATS, no module gate: these tools only compute over numbers
 * the specialist has already read with the farm query tools.
 *
 * Tool registration is automatic: ToolRegistryService discovers every
 * @Tool()-decorated provider via DiscoveryService (FAZ0-BOOT-01).
 */
@Module({
  providers: [...TOOLS],
  exports: [...TOOLS],
})
export class AquacultureMathToolsModule {}
