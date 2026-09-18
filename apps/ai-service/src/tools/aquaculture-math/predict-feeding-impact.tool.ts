import { Injectable } from '@nestjs/common';
import { feedingImpact, type FeedingImpactResult } from '@platform/aquaculture-engines';
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
} from './aquaculture-math.schema';

interface FeedingImpactInput {
  feedKg: number;
  biomassKg: number;
  tankVolumeM3: number;
  temperatureC: number;
  salinityPpt?: number;
  currentPH: number;
  currentTanMgL?: number;
  hasBiofilter?: boolean;
  feedProteinPercent?: number;
  speciesCode?: string;
}

/**
 * What one day's ration does to TAN, un-ionised ammonia risk and oxygen
 * demand — pure arithmetic from @platform/aquaculture-engines (the ammonia
 * engine supplies the NH3 fraction and critical pH).
 */
@Injectable()
@Tool({
  name: 'predict_feeding_impact',
  description:
    "Predict the water-quality impact of a day's feed: TAN produced (from feed protein % or a species coefficient) and the resulting peak TAN in the tank, the un-ionised NH3 at the current pH versus the species limit with the critical pH and safety margin, the O2 demand it creates (mg/L/h), and the feeding rate as % body weight. Use before recommending a ration change; take biomass, volume, pH and temperature from tool results.",
  category: 'feed_management',
  runtime: 'both',
  requiredPermissions: ALL_TIERS,
  inputSchema: {
    type: 'object',
    properties: {
      feedKg: { ...POSITIVE_NUMBER_SCHEMA, description: 'Feed to be given today (kg)' },
      biomassKg: { ...POSITIVE_NUMBER_SCHEMA, description: 'Current biomass (kg)' },
      tankVolumeM3: { ...POSITIVE_NUMBER_SCHEMA, description: 'Tank water volume (m³)' },
      temperatureC: TEMPERATURE_SCHEMA,
      salinityPpt: SALINITY_SCHEMA,
      currentPH: { type: 'number', description: 'Current pH (NBS scale)', minimum: 4, maximum: 12 },
      currentTanMgL: { type: 'number', description: 'Current TAN (mg/L), optional', minimum: 0 },
      hasBiofilter: {
        type: 'boolean',
        description: 'RAS biofilter present (adds nitrification demand)',
      },
      feedProteinPercent: {
        type: 'number',
        description: 'Feed protein (%), e.g. 42; when given TAN = 0.092 × protein fraction',
        minimum: 0,
        maximum: 100,
      },
      speciesCode: {
        type: 'string',
        description:
          'Species code for limits/coefficients (salmon, trout, tilapia, seabass, seabream, catfish, shrimp)',
      },
    },
    required: ['feedKg', 'biomassKg', 'tankVolumeM3', 'temperatureC', 'currentPH'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class PredictFeedingImpactTool extends BaseTool<FeedingImpactInput, FeedingImpactResult> {
  protected async run(
    input: FeedingImpactInput,
    _ctx: ToolExecutionContext,
  ): Promise<FeedingImpactResult> {
    return feedingImpact(input);
  }

  async validate(input: FeedingImpactInput): Promise<{ valid: boolean; errors?: string[] }> {
    const errors = [
      ...requireFinite('feedKg', input.feedKg, Number.MIN_VALUE),
      ...requireFinite('biomassKg', input.biomassKg, Number.MIN_VALUE),
      ...requireFinite('tankVolumeM3', input.tankVolumeM3, Number.MIN_VALUE),
      ...requireFinite('temperatureC', input.temperatureC, 0, 45),
      ...requireFinite('currentPH', input.currentPH, 4, 12),
      ...requireOptionalFinite('salinityPpt', input.salinityPpt, 0, 45),
      ...requireOptionalFinite('currentTanMgL', input.currentTanMgL, 0),
      ...requireOptionalFinite('feedProteinPercent', input.feedProteinPercent, 0, 100),
    ];
    if (input.speciesCode !== undefined && typeof input.speciesCode !== 'string') {
      errors.push('speciesCode must be a string');
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
