import { Module } from '@nestjs/common';
import { CalculateAmmoniaToxicityTool } from './calculate-ammonia-toxicity.tool';
import { CalculateH2SToxicityTool } from './calculate-h2s-toxicity.tool';
import { CalculateCO2LevelTool } from './calculate-co2-level.tool';
import { CalculateCarbonateTool } from './calculate-carbonate-chemistry.tool';
import { CalculateReagentDosingTool } from './calculate-reagent-dosing.tool';
import { GetReagentListTool } from './get-reagent-list.tool';
import { SimulateDosingEffectTool } from './simulate-dosing-effect.tool';

const TOOLS = [
  CalculateAmmoniaToxicityTool,
  CalculateH2SToxicityTool,
  CalculateCO2LevelTool,
  CalculateCarbonateTool,
  CalculateReagentDosingTool,
  GetReagentListTool,
  SimulateDosingEffectTool,
];

// Tool registration is automatic: ToolRegistryService discovers every
// @Tool()-decorated provider via DiscoveryService (FAZ0-BOOT-01). Declaring
// the classes as providers is the complete registration.
@Module({
  providers: [...TOOLS],
  exports: [...TOOLS],
})
export class WaterChemistryToolsModule {}
