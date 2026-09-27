import { Injectable } from '@nestjs/common';
import {
  biomass,
  feedConversionRatio,
  growthProjection,
  specificGrowthRate,
  transferDensity,
  type BiomassResult,
  type FcrResult,
  type GrowthProjectionResult,
  type GrowthProjectionSample,
  type SgrResult,
  type TransferDensityResult,
  type TransferTank,
} from '@platform/aquaculture-engines';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  ALL_TIERS,
  POSITIVE_NUMBER_SCHEMA,
  requireFinite,
  requireOptionalFinite,
  roundNumbersDeep,
} from './aquaculture-math.schema';

type GrowthMode = 'sgr' | 'fcr' | 'biomass' | 'projection' | 'transfer_density';

interface GrowthMetricsInput {
  mode: GrowthMode;
  // sgr
  initialWeightG?: number;
  finalWeightG?: number;
  days?: number;
  // fcr
  feedConsumedKg?: number;
  biomassGainKg?: number;
  speciesCode?: string;
  // biomass
  quantity?: number;
  avgWeightG?: number;
  tankVolumeM3?: number;
  // projection
  currentWeightG?: number;
  currentQuantity?: number;
  targetWeightG?: number;
  sgrPercentPerDay?: number;
  mortalityRatePercent?: number;
  projectionDays?: number;
  dailyFeedingRatePercent?: number;
  // transfer_density
  sourceTank?: TransferTank;
  destTank?: TransferTank;
  transferBiomassKg?: number;
}

type GrowthMetricsOutput =
  | ({ mode: 'sgr' } & SgrResult)
  | ({ mode: 'fcr' } & FcrResult)
  | ({ mode: 'biomass' } & BiomassResult)
  | ({ mode: 'projection' } & GrowthProjectionResult)
  | ({ mode: 'transfer_density' } & TransferDensityResult);

const TANK_SCHEMA = {
  type: 'object',
  properties: {
    volumeM3: { ...POSITIVE_NUMBER_SCHEMA, description: 'Tank volume (m³)' },
    currentBiomassKg: { type: 'number', description: 'Current biomass (kg)', minimum: 0 },
    maxDensityKgM3: { ...POSITIVE_NUMBER_SCHEMA, description: 'Maximum density (kg/m³)' },
  },
  required: ['volumeM3', 'currentBiomassKg', 'maxDensityKgM3'],
} as const;

const MODE_REQUIRED: Readonly<Record<GrowthMode, readonly (keyof GrowthMetricsInput)[]>> = {
  sgr: ['initialWeightG', 'finalWeightG', 'days'],
  fcr: ['feedConsumedKg', 'biomassGainKg'],
  biomass: ['quantity', 'avgWeightG'],
  projection: ['currentWeightG', 'currentQuantity', 'sgrPercentPerDay'],
  transfer_density: ['sourceTank', 'destTank', 'transferBiomassKg'],
};

function wholeFish(sample: GrowthProjectionSample): GrowthProjectionSample {
  return {
    ...sample,
    quantity: Math.round(sample.quantity),
    cumulativeMortality: Math.round(sample.cumulativeMortality),
  };
}

function isTransferTank(value: unknown): value is TransferTank {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.volumeM3 === 'number' &&
    t.volumeM3 > 0 &&
    typeof t.currentBiomassKg === 'number' &&
    t.currentBiomassKg >= 0 &&
    typeof t.maxDensityKgM3 === 'number' &&
    t.maxDensityKgM3 > 0
  );
}

/**
 * Growth arithmetic in five modes — SGR, FCR against industry benchmarks,
 * biomass/density, an exponential growth projection and a tank-transfer
 * density check. Pure arithmetic from @platform/aquaculture-engines; the
 * numbers to feed it come from get_batch_performance, list_growth_measurements,
 * get_feeding_summary and get_tank_capacity.
 */
@Injectable()
@Tool({
  name: 'calculate_growth_metrics',
  description:
    'Growth calculations by mode: "sgr" (initialWeightG, finalWeightG, days → %/day + rating), "fcr" (feedConsumedKg, biomassGainKg[, speciesCode] → FCR vs industry average), "biomass" (quantity, avgWeightG[, tankVolumeM3] → kg and density status), "projection" (currentWeightG, currentQuantity, sgrPercentPerDay[, targetWeightG, mortalityRatePercent, projectionDays, dailyFeedingRatePercent] → weekly samples, harvest day, feed, survival), "transfer_density" (sourceTank, destTank, transferBiomassKg → before/after loads, max safe transfer). Use measured values from tool results.',
  category: 'growth_analytics',
  runtime: 'both',
  requiredPermissions: ALL_TIERS,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['sgr', 'fcr', 'biomass', 'projection', 'transfer_density'] },
      initialWeightG: { ...POSITIVE_NUMBER_SCHEMA, description: 'sgr: initial weight (g)' },
      finalWeightG: { ...POSITIVE_NUMBER_SCHEMA, description: 'sgr: final weight (g)' },
      days: { ...POSITIVE_NUMBER_SCHEMA, description: 'sgr: period (days)' },
      feedConsumedKg: { ...POSITIVE_NUMBER_SCHEMA, description: 'fcr: feed consumed (kg)' },
      biomassGainKg: { ...POSITIVE_NUMBER_SCHEMA, description: 'fcr: biomass gained (kg)' },
      speciesCode: { type: 'string', description: 'fcr: species code for the industry benchmark' },
      quantity: { type: 'integer', description: 'biomass: fish count', minimum: 1 },
      avgWeightG: { ...POSITIVE_NUMBER_SCHEMA, description: 'biomass: average weight (g)' },
      tankVolumeM3: {
        ...POSITIVE_NUMBER_SCHEMA,
        description: 'biomass: tank volume (m³) for density',
      },
      currentWeightG: {
        ...POSITIVE_NUMBER_SCHEMA,
        description: 'projection: current average weight (g)',
      },
      currentQuantity: {
        type: 'integer',
        description: 'projection: current fish count',
        minimum: 1,
      },
      targetWeightG: { ...POSITIVE_NUMBER_SCHEMA, description: 'projection: target weight (g)' },
      sgrPercentPerDay: { ...POSITIVE_NUMBER_SCHEMA, description: 'projection: SGR (%/day)' },
      mortalityRatePercent: {
        type: 'number',
        description: 'projection: daily mortality (% of stock)',
        minimum: 0,
        maximum: 100,
      },
      projectionDays: {
        type: 'integer',
        description: 'projection: horizon (days), ≤ 365',
        minimum: 1,
      },
      dailyFeedingRatePercent: {
        type: 'number',
        description: 'projection: feed (% BW/day), default 2',
        minimum: 0,
        maximum: 20,
      },
      sourceTank: { ...TANK_SCHEMA, description: 'transfer_density: source tank' },
      destTank: { ...TANK_SCHEMA, description: 'transfer_density: destination tank' },
      transferBiomassKg: {
        ...POSITIVE_NUMBER_SCHEMA,
        description: 'transfer_density: biomass to move (kg)',
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateGrowthMetricsTool extends BaseTool<GrowthMetricsInput, GrowthMetricsOutput> {
  protected async run(
    input: GrowthMetricsInput,
    _ctx: ToolExecutionContext,
  ): Promise<GrowthMetricsOutput> {
    return roundNumbersDeep(this.compute(input));
  }

  private compute(input: GrowthMetricsInput): GrowthMetricsOutput {
    switch (input.mode) {
      case 'sgr':
        return {
          mode: 'sgr',
          ...specificGrowthRate(
            input.initialWeightG as number,
            input.finalWeightG as number,
            input.days as number,
          ),
        };
      case 'fcr':
        return {
          mode: 'fcr',
          ...feedConversionRatio(
            input.feedConsumedKg as number,
            input.biomassGainKg as number,
            input.speciesCode,
          ),
        };
      case 'biomass':
        return {
          mode: 'biomass',
          ...biomass(input.quantity as number, input.avgWeightG as number, input.tankVolumeM3),
        };
      case 'projection': {
        const projection = growthProjection({
          currentWeightG: input.currentWeightG as number,
          currentQuantity: input.currentQuantity as number,
          sgrPercentPerDay: input.sgrPercentPerDay as number,
          targetWeightG: input.targetWeightG,
          mortalityRatePercent: input.mortalityRatePercent,
          projectionDays: input.projectionDays,
          dailyFeedingRatePercent: input.dailyFeedingRatePercent,
        });
        // Presentation: fish are counted whole; the engine's continuous
        // mortality model yields fractional stock.
        const samples = projection.samples.map(wholeFish);
        return {
          mode: 'projection',
          ...projection,
          samples,
          final: samples[samples.length - 1] as GrowthProjectionSample,
        };
      }
      case 'transfer_density':
        return {
          mode: 'transfer_density',
          ...transferDensity(
            input.sourceTank as TransferTank,
            input.destTank as TransferTank,
            input.transferBiomassKg as number,
          ),
        };
    }
  }

  async validate(input: GrowthMetricsInput): Promise<{ valid: boolean; errors?: string[] }> {
    if (!input || !(input.mode in MODE_REQUIRED)) {
      return {
        valid: false,
        errors: ['mode must be one of sgr, fcr, biomass, projection, transfer_density'],
      };
    }
    const errors: string[] = [];
    for (const field of MODE_REQUIRED[input.mode]) {
      if (input[field] === undefined) errors.push(`${field} is required for mode ${input.mode}`);
    }
    if (errors.length > 0) return { valid: false, errors };

    switch (input.mode) {
      case 'sgr':
        errors.push(
          ...requireFinite('initialWeightG', input.initialWeightG, Number.MIN_VALUE),
          ...requireFinite('finalWeightG', input.finalWeightG, Number.MIN_VALUE),
          ...requireFinite('days', input.days, Number.MIN_VALUE),
        );
        break;
      case 'fcr':
        errors.push(
          ...requireFinite('feedConsumedKg', input.feedConsumedKg, Number.MIN_VALUE),
          ...requireFinite('biomassGainKg', input.biomassGainKg, Number.MIN_VALUE),
        );
        break;
      case 'biomass':
        errors.push(
          ...requireFinite('quantity', input.quantity, 1),
          ...requireFinite('avgWeightG', input.avgWeightG, Number.MIN_VALUE),
          ...requireOptionalFinite('tankVolumeM3', input.tankVolumeM3, Number.MIN_VALUE),
        );
        break;
      case 'projection':
        errors.push(
          ...requireFinite('currentWeightG', input.currentWeightG, Number.MIN_VALUE),
          ...requireFinite('currentQuantity', input.currentQuantity, 1),
          ...requireFinite('sgrPercentPerDay', input.sgrPercentPerDay, Number.MIN_VALUE),
          ...requireOptionalFinite('targetWeightG', input.targetWeightG, Number.MIN_VALUE),
          ...requireOptionalFinite('mortalityRatePercent', input.mortalityRatePercent, 0, 100),
          ...requireOptionalFinite('projectionDays', input.projectionDays, 1),
          ...requireOptionalFinite('dailyFeedingRatePercent', input.dailyFeedingRatePercent, 0, 20),
        );
        if (input.targetWeightG === undefined && input.projectionDays === undefined) {
          errors.push('projection needs targetWeightG or projectionDays');
        }
        break;
      case 'transfer_density':
        if (!isTransferTank(input.sourceTank))
          errors.push(
            'sourceTank must have volumeM3 > 0, currentBiomassKg ≥ 0, maxDensityKgM3 > 0',
          );
        if (!isTransferTank(input.destTank))
          errors.push('destTank must have volumeM3 > 0, currentBiomassKg ≥ 0, maxDensityKgM3 > 0');
        errors.push(
          ...requireFinite('transferBiomassKg', input.transferBiomassKg, Number.MIN_VALUE),
        );
        break;
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
