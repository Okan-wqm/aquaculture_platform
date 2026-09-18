import { Injectable } from '@nestjs/common';
import { oxygenBudget, type OxygenBudgetResult } from '@platform/aquaculture-engines';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  ALL_TIERS,
  POSITIVE_NUMBER_SCHEMA,
  SALINITY_SCHEMA,
  TEMPERATURE_SCHEMA,
  requireFinite,
  requireOptionalFinite,
  roundNumbersDeep,
} from './aquaculture-math.schema';

interface OxygenBudgetInput {
  temperatureC: number;
  salinityPpt?: number;
  dailyFeedKg: number;
  tankVolumeM3: number;
  currentDoMgL: number;
  hasBiofilter?: boolean;
  waterFlowM3h?: number;
  minSafeDoMgL?: number;
}

/**
 * Oxygen budget for one tank — pure arithmetic from @platform/aquaculture-engines
 * (the same engine the MCP `calculate_oxygen_budget` tool wraps). The result is
 * the engine's shape; units are in the field names.
 */
@Injectable()
@Tool({
  name: 'calculate_oxygen_budget',
  description:
    'Compute a tank oxygen budget: Weiss DO saturation and saturation %, daily O2 demand (fish, organic, biofilter) and its mg/L/h rate, hours until DO reaches 5 mg/L with no aeration, temperature sensitivity, and the steady-state DO for a given exchange flow. Use for aeration/emergency planning; take temperature, DO and feed from tool results, not assumptions.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ALL_TIERS,
  inputSchema: {
    type: 'object',
    properties: {
      temperatureC: TEMPERATURE_SCHEMA,
      salinityPpt: SALINITY_SCHEMA,
      dailyFeedKg: { ...POSITIVE_NUMBER_SCHEMA, description: 'Daily feed (kg)' },
      tankVolumeM3: { ...POSITIVE_NUMBER_SCHEMA, description: 'Tank water volume (m³)' },
      currentDoMgL: { type: 'number', description: 'Current dissolved oxygen (mg/L)', minimum: 0 },
      hasBiofilter: {
        type: 'boolean',
        description: 'RAS biofilter present (adds nitrification demand)',
      },
      waterFlowM3h: {
        type: 'number',
        description: 'Fresh-water exchange flow (m³/h), optional',
        minimum: 0,
      },
      minSafeDoMgL: {
        type: 'number',
        description: 'Minimum safe DO (mg/L), default 5',
        minimum: 0,
      },
    },
    required: ['temperatureC', 'dailyFeedKg', 'tankVolumeM3', 'currentDoMgL'],
    additionalProperties: false,
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateOxygenBudgetTool extends BaseTool<OxygenBudgetInput, OxygenBudgetResult> {
  protected async run(
    input: OxygenBudgetInput,
    _ctx: ToolExecutionContext,
  ): Promise<OxygenBudgetResult> {
    // Explicit field mapping: only declared, validated fields reach the engine.
    return roundNumbersDeep(
      oxygenBudget({
        temperatureC: input.temperatureC,
        salinityPpt: input.salinityPpt,
        dailyFeedKg: input.dailyFeedKg,
        tankVolumeM3: input.tankVolumeM3,
        currentDoMgL: input.currentDoMgL,
        hasBiofilter: input.hasBiofilter,
        waterFlowM3h: input.waterFlowM3h,
        minSafeDoMgL: input.minSafeDoMgL,
      }),
    );
  }

  async validate(input: OxygenBudgetInput): Promise<{ valid: boolean; errors?: string[] }> {
    const errors = [
      ...requireFinite('temperatureC', input.temperatureC, 0, 45),
      ...requireFinite('dailyFeedKg', input.dailyFeedKg, 0),
      ...requireFinite('tankVolumeM3', input.tankVolumeM3, Number.MIN_VALUE),
      ...requireFinite('currentDoMgL', input.currentDoMgL, 0),
    ];
    errors.push(...requireOptionalFinite('salinityPpt', input.salinityPpt, 0, 45));
    errors.push(...requireOptionalFinite('waterFlowM3h', input.waterFlowM3h, 0));
    errors.push(...requireOptionalFinite('minSafeDoMgL', input.minSafeDoMgL, 0));
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
