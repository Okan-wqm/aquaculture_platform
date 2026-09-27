import { Injectable } from '@nestjs/common';
import { carryingCapacity, type CarryingCapacityResult } from '@platform/aquaculture-engines';
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

interface CarryingCapacityInput {
  tankVolumeM3: number;
  temperatureC: number;
  salinityPpt?: number;
  minSafeDoMgL?: number;
  maxDensityKgM3: number;
  avgFishWeightG: number;
  dailyFeedingRatePercent: number;
  hasBiofilter?: boolean;
}

/**
 * Tank carrying capacity under the stocking-density and oxygen limits — pure
 * arithmetic from @platform/aquaculture-engines. Pair with get_tank_capacity
 * (the tenant's configured capacity) when advising on stocking.
 */
@Injectable()
@Tool({
  name: 'calculate_carrying_capacity',
  description:
    'Compute the maximum biomass and fish count a tank can hold: the stocking-density limit (max kg/m³ × volume) versus the oxygen limit (DO held above the safe floor divided by O2 demand per kg biomass at the feeding rate), and which one binds. Use when planning stocking or transfers; take volume, temperature and weights from tool results.',
  category: 'growth_analytics',
  runtime: 'both',
  requiredPermissions: ALL_TIERS,
  inputSchema: {
    type: 'object',
    properties: {
      tankVolumeM3: { ...POSITIVE_NUMBER_SCHEMA, description: 'Tank water volume (m³)' },
      temperatureC: TEMPERATURE_SCHEMA,
      salinityPpt: SALINITY_SCHEMA,
      minSafeDoMgL: {
        type: 'number',
        description: 'Minimum safe DO (mg/L), default 5',
        minimum: 0,
      },
      maxDensityKgM3: {
        ...POSITIVE_NUMBER_SCHEMA,
        description: 'Maximum stocking density for the species/system (kg/m³)',
      },
      avgFishWeightG: { ...POSITIVE_NUMBER_SCHEMA, description: 'Average fish weight (g)' },
      dailyFeedingRatePercent: {
        type: 'number',
        description: 'Daily feeding rate (% body weight)',
        minimum: 0,
        maximum: 20,
      },
      hasBiofilter: {
        type: 'boolean',
        description: 'RAS biofilter present (adds nitrification demand)',
      },
    },
    required: [
      'tankVolumeM3',
      'temperatureC',
      'maxDensityKgM3',
      'avgFishWeightG',
      'dailyFeedingRatePercent',
    ],
    additionalProperties: false,
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateCarryingCapacityTool extends BaseTool<
  CarryingCapacityInput,
  CarryingCapacityResult
> {
  protected async run(
    input: CarryingCapacityInput,
    _ctx: ToolExecutionContext,
  ): Promise<CarryingCapacityResult> {
    return roundNumbersDeep(
      carryingCapacity({
        tankVolumeM3: input.tankVolumeM3,
        temperatureC: input.temperatureC,
        salinityPpt: input.salinityPpt,
        minSafeDoMgL: input.minSafeDoMgL,
        maxDensityKgM3: input.maxDensityKgM3,
        avgFishWeightG: input.avgFishWeightG,
        dailyFeedingRatePercent: input.dailyFeedingRatePercent,
        hasBiofilter: input.hasBiofilter,
      }),
    );
  }

  async validate(input: CarryingCapacityInput): Promise<{ valid: boolean; errors?: string[] }> {
    const errors = [
      ...requireFinite('tankVolumeM3', input.tankVolumeM3, Number.MIN_VALUE),
      ...requireFinite('temperatureC', input.temperatureC, 0, 45),
      ...requireFinite('maxDensityKgM3', input.maxDensityKgM3, Number.MIN_VALUE),
      ...requireFinite('avgFishWeightG', input.avgFishWeightG, Number.MIN_VALUE),
      ...requireFinite('dailyFeedingRatePercent', input.dailyFeedingRatePercent, 0, 20),
      ...requireOptionalFinite('salinityPpt', input.salinityPpt, 0, 45),
      ...requireOptionalFinite('minSafeDoMgL', input.minSafeDoMgL, 0),
    ];
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
