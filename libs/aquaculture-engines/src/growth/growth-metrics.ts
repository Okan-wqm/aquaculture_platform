/**
 * Growth metrics — SGR, FCR, biomass/density, exponential growth projection
 * and tank-transfer density. Pure arithmetic; presentation belongs to the
 * caller.
 *
 * REFERENCES: Jobling (1994) Fish Bioenergetics (SGR); industry FCR
 * benchmarks per species from producer reports (indicative, not normative).
 */

// ── SGR ──────────────────────────────────────────────────────────────────

export type GrowthRating = 'excellent' | 'good' | 'average' | 'poor';

export interface SgrResult {
  /** %/day: ((ln Wf − ln Wi) / days) × 100. */
  sgrPercentPerDay: number;
  rating: GrowthRating;
  weightGainG: number;
  weightGainPercent: number;
  /** ln 2 / (SGR/100); null when SGR ≤ 0. */
  doublingTimeDays: number | null;
}

export function sgrRating(sgrPercentPerDay: number): GrowthRating {
  if (sgrPercentPerDay > 3) return 'excellent';
  if (sgrPercentPerDay >= 2) return 'good';
  if (sgrPercentPerDay >= 1) return 'average';
  return 'poor';
}

export function specificGrowthRate(
  initialWeightG: number,
  finalWeightG: number,
  days: number,
): SgrResult {
  const sgrPercentPerDay = ((Math.log(finalWeightG) - Math.log(initialWeightG)) / days) * 100;
  const weightGainG = finalWeightG - initialWeightG;
  return {
    sgrPercentPerDay,
    rating: sgrRating(sgrPercentPerDay),
    weightGainG,
    weightGainPercent: (weightGainG / initialWeightG) * 100,
    doublingTimeDays: sgrPercentPerDay > 0 ? Math.log(2) / (sgrPercentPerDay / 100) : null,
  };
}

// ── FCR ──────────────────────────────────────────────────────────────────

/** Indicative industry-average FCR by species code (lower-case). */
export const INDUSTRY_FCR: Readonly<Record<string, number>> = Object.freeze({
  salmon: 1.2,
  trout: 1.1,
  seabass: 1.8,
  seabream: 2.0,
  tilapia: 1.6,
});
export const DEFAULT_INDUSTRY_FCR = 1.5;

export type FcrEfficiency = 'excellent' | 'good' | 'average' | 'poor';

export interface FcrResult {
  fcr: number;
  industryAverageFcr: number;
  /** (FCR − industry) / industry × 100; negative = better than average. */
  deviationFromIndustryPercent: number;
  efficiency: FcrEfficiency;
  /** Feed saved over the same gain if FCR improved by 0.1. */
  feedSavingsKgIfImproved01: number;
}

/** Own-key lookup only: a model-supplied code such as `constructor` must fall to the default, not to Object.prototype. */
function tableLookup(
  table: Readonly<Record<string, number>>,
  key: string,
  fallback: number,
): number {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as number) : fallback;
}

export function industryFcrFor(speciesCode: string | undefined): number {
  return tableLookup(INDUSTRY_FCR, speciesCode?.toLowerCase() ?? '', DEFAULT_INDUSTRY_FCR);
}

export function fcrEfficiency(fcr: number, industryAverage: number): FcrEfficiency {
  if (fcr <= industryAverage * 0.85) return 'excellent';
  if (fcr <= industryAverage) return 'good';
  if (fcr <= industryAverage * 1.2) return 'average';
  return 'poor';
}

export function feedConversionRatio(
  feedConsumedKg: number,
  biomassGainKg: number,
  speciesCode?: string,
): FcrResult {
  const fcr = feedConsumedKg / biomassGainKg;
  const industryAverageFcr = industryFcrFor(speciesCode);
  return {
    fcr,
    industryAverageFcr,
    deviationFromIndustryPercent: ((fcr - industryAverageFcr) / industryAverageFcr) * 100,
    efficiency: fcrEfficiency(fcr, industryAverageFcr),
    feedSavingsKgIfImproved01: biomassGainKg * 0.1,
  };
}

// ── Biomass / density ────────────────────────────────────────────────────

export type DensityStatus = 'low' | 'normal' | 'high' | 'excessive';

export function densityStatus(densityKgM3: number): DensityStatus {
  if (densityKgM3 < 5) return 'low';
  if (densityKgM3 <= 15) return 'normal';
  if (densityKgM3 <= 30) return 'high';
  return 'excessive';
}

export interface BiomassResult {
  biomassKg: number;
  densityKgM3: number | null;
  densityStatus: DensityStatus | null;
}

export function biomass(
  quantity: number,
  avgWeightG: number,
  tankVolumeM3?: number,
): BiomassResult {
  const biomassKg = (quantity * avgWeightG) / 1000;
  if (tankVolumeM3 === undefined || tankVolumeM3 <= 0) {
    return { biomassKg, densityKgM3: null, densityStatus: null };
  }
  const densityKgM3 = biomassKg / tankVolumeM3;
  return { biomassKg, densityKgM3, densityStatus: densityStatus(densityKgM3) };
}

// ── Projection ───────────────────────────────────────────────────────────

export interface GrowthProjectionInput {
  currentWeightG: number;
  currentQuantity: number;
  /** %/day. */
  sgrPercentPerDay: number;
  targetWeightG?: number;
  /** Daily mortality, % of stock per day (default 0). */
  mortalityRatePercent?: number;
  /** Simulation length; defaults to ceil(days to target) or 90; capped at 365. */
  projectionDays?: number;
  /** Daily feed as % of body weight (default 2). */
  dailyFeedingRatePercent?: number;
}

export interface GrowthProjectionSample {
  day: number;
  avgWeightG: number;
  quantity: number;
  biomassKg: number;
  dailyFeedKg: number;
  cumulativeFeedKg: number;
  cumulativeMortality: number;
}

export interface GrowthProjectionResult {
  simulationDays: number;
  /** Analytical days to target at the given SGR; null without a target above the current weight. */
  estimatedHarvestDays: number | null;
  /** First simulated day on which the target weight is met; null if never within the horizon. */
  targetReachedDay: number | null;
  /** Weekly samples plus day 0, the last day and the target-reached day. */
  samples: GrowthProjectionSample[];
  final: GrowthProjectionSample;
  survivalRatePercent: number;
}

export const MAX_PROJECTION_DAYS = 365;

export function growthProjection(input: GrowthProjectionInput): GrowthProjectionResult {
  const mortality = input.mortalityRatePercent ?? 0;
  const feedingRate = input.dailyFeedingRatePercent ?? 2;
  const target = input.targetWeightG;

  const estimatedHarvestDays =
    target !== undefined && target > input.currentWeightG
      ? Math.log(target / input.currentWeightG) / (input.sgrPercentPerDay / 100)
      : null;

  const requestedDays =
    input.projectionDays ?? (estimatedHarvestDays !== null ? Math.ceil(estimatedHarvestDays) : 90);
  const simulationDays = Math.min(requestedDays, MAX_PROJECTION_DAYS);

  const samples: GrowthProjectionSample[] = [];
  let weight = input.currentWeightG;
  let quantity = input.currentQuantity;
  let cumulativeFeed = 0;
  let cumulativeMortality = 0;
  let targetReachedDay: number | null = null;

  for (let day = 0; day <= simulationDays; day++) {
    const biomassKg = (quantity * weight) / 1000;
    const dailyFeedKg = biomassKg * (feedingRate / 100);
    if (day > 0) cumulativeFeed += dailyFeedKg;

    const reachesTarget = target !== undefined && weight >= target && targetReachedDay === null;
    if (day === 0 || day === simulationDays || day % 7 === 0 || reachesTarget) {
      samples.push({
        day,
        avgWeightG: weight,
        quantity,
        biomassKg,
        dailyFeedKg,
        cumulativeFeedKg: cumulativeFeed,
        cumulativeMortality,
      });
    }
    if (reachesTarget) targetReachedDay = day;

    weight *= Math.exp(input.sgrPercentPerDay / 100);
    const deaths = quantity * (mortality / 100);
    quantity -= deaths;
    cumulativeMortality += deaths;
  }

  const final = samples[samples.length - 1] as GrowthProjectionSample;
  return {
    simulationDays,
    estimatedHarvestDays,
    targetReachedDay,
    samples,
    final,
    survivalRatePercent: (final.quantity / input.currentQuantity) * 100,
  };
}

// ── Transfer density ─────────────────────────────────────────────────────

export interface TransferTank {
  volumeM3: number;
  currentBiomassKg: number;
  maxDensityKgM3: number;
}

export interface TankLoad {
  biomassKg: number;
  densityKgM3: number;
  utilizationPercent: number;
}

export interface TransferDensityResult {
  source: { before: TankLoad; after: TankLoad };
  destination: { before: TankLoad; after: TankLoad };
  /** min(source biomass, destination free capacity). */
  maxSafeTransferKg: number;
  sourceInsufficient: boolean;
  destinationOverMax: boolean;
  /** kg above the destination ceiling after the transfer (0 when within). */
  destinationExcessKg: number;
  feasible: boolean;
}

function tankLoad(tank: TransferTank, biomassKg: number): TankLoad {
  return {
    biomassKg,
    densityKgM3: biomassKg / tank.volumeM3,
    utilizationPercent: (biomassKg / (tank.maxDensityKgM3 * tank.volumeM3)) * 100,
  };
}

export function transferDensity(
  source: TransferTank,
  destination: TransferTank,
  transferBiomassKg: number,
): TransferDensityResult {
  const sourceAfterKg = source.currentBiomassKg - transferBiomassKg;
  const destinationAfterKg = destination.currentBiomassKg + transferBiomassKg;
  const destinationCapacityKg = destination.maxDensityKgM3 * destination.volumeM3;
  const sourceInsufficient = sourceAfterKg < 0;
  const destinationOverMax = destinationAfterKg / destination.volumeM3 > destination.maxDensityKgM3;
  return {
    source: {
      before: tankLoad(source, source.currentBiomassKg),
      after: tankLoad(source, Math.max(0, sourceAfterKg)),
    },
    destination: {
      before: tankLoad(destination, destination.currentBiomassKg),
      after: tankLoad(destination, destinationAfterKg),
    },
    maxSafeTransferKg: Math.min(
      source.currentBiomassKg,
      Math.max(0, destinationCapacityKg - destination.currentBiomassKg),
    ),
    sourceInsufficient,
    destinationOverMax,
    destinationExcessKg: destinationOverMax ? destinationAfterKg - destinationCapacityKg : 0,
    feasible: !sourceInsufficient && !destinationOverMax,
  };
}
