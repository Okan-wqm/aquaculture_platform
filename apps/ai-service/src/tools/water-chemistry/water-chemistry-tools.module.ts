import { Module } from '@nestjs/common';
import { TOOL_PROVIDERS } from '../core/tool.interface';
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

@Module({
  providers: [
    ...TOOLS,
    // Multi-provider registration for tool registry discovery
    ...TOOLS.map((tool) => ({
      provide: TOOL_PROVIDERS,
      useExisting: tool,
    })),
  ],
  exports: [TOOL_PROVIDERS],
})
export class WaterChemistryToolsModule {}
