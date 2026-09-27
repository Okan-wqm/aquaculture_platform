/**
 * Feeding impact — what one day's ration does to TAN, un-ionised ammonia
 * risk and oxygen demand in a tank. Pure arithmetic over the shared ammonia
 * and oxygen engines.
 *
 * REFERENCES: TAN yield ≈ 0.092 kg TAN per kg protein fed (Timmons &
 * Ebeling 2013); species NH3 chronic limits — salmonids 0.012 mg/L NH3-N,
 * tilapia 0.05, sea bass/bream 0.02 (indicative).
 */
import { o2ConsumptionRateMgLPerHour, o2Demand, type O2Demand } from '../oxygen/do-saturation.js';
import { criticalPHforNH3, fractionNH3, uiaStatus } from '../water-chemistry/ammonia-calc.js';

/** kg TAN produced per kg of dietary protein. */
export const TAN_PER_KG_PROTEIN = 0.092;

/** Fallback TAN yield per kg feed by species (≈40 % protein diets). */
export const TAN_PER_KG_FEED_BY_SPECIES: Readonly<Record<string, number>> = Object.freeze({
  salmon: 0.028,
  trout: 0.028,
  tilapia: 0.032,
  seabass: 0.03,
  seabream: 0.03,
  catfish: 0.03,
  shrimp: 0.025,
});
export const DEFAULT_TAN_PER_KG_FEED = 0.03;

/** Chronic un-ionised ammonia limits by species (mg/L NH3-N). */
export const NH3_LIMIT_BY_SPECIES: Readonly<Record<string, number>> = Object.freeze({
  salmon: 0.012,
  trout: 0.012,
  tilapia: 0.05,
  seabass: 0.02,
  seabream: 0.02,
});
export const DEFAULT_NH3_LIMIT_MG_L = 0.02;

export type FeedingRateStatus = 'low' | 'normal' | 'high' | 'overfeeding';
export type TanMethod = 'protein_based' | 'species_coefficient';

export interface FeedingImpactInput {
  feedKg: number;
  biomassKg: number;
  tankVolumeM3: number;
  temperatureC: number;
  salinityPpt?: number;
  currentPH: number;
  currentTanMgL?: number;
  hasBiofilter?: boolean;
  /** When given (>0), TAN = feed × 0.092 × protein fraction. */
  feedProteinPercent?: number;
  speciesCode?: string;
}

export interface FeedingImpactResult {
  tan: {
    method: TanMethod;
    coefficientKgPerKgFeed: number;
    producedKg: number;
    increaseMgL: number;
    peakMgL: number;
  };
  ammonia: {
    nh3Fraction: number;
    peakNh3MgL: number;
    limitMgL: number;
    exceedsLimit: boolean;
    /** pH at which peak TAN reaches the limit; null when unreachable. */
    criticalPH: number | null;
    safetyMarginPH: number | null;
    status: 'safe' | 'alert' | 'danger';
  };
  oxygen: O2Demand & { consumptionRateMgLPerHour: number };
  feedingRate: { ratePercentBw: number; status: FeedingRateStatus };
}

export function feedingRateStatus(ratePercentBw: number): FeedingRateStatus {
  if (ratePercentBw < 0.5) return 'low';
  if (ratePercentBw <= 3) return 'normal';
  if (ratePercentBw <= 5) return 'high';
  return 'overfeeding';
}

/** Own-key lookup only: a model-supplied code such as `constructor` must fall to the default, not to Object.prototype. */
function tableLookup(
  table: Readonly<Record<string, number>>,
  key: string,
  fallback: number,
): number {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as number) : fallback;
}

export function nh3LimitFor(speciesCode: string | undefined): number {
  return tableLookup(
    NH3_LIMIT_BY_SPECIES,
    speciesCode?.toLowerCase() ?? '',
    DEFAULT_NH3_LIMIT_MG_L,
  );
}

export function tanCoefficientFor(
  speciesCode: string | undefined,
  feedProteinPercent: number | undefined,
): { method: TanMethod; coefficientKgPerKgFeed: number } {
  if (feedProteinPercent !== undefined && feedProteinPercent > 0) {
    return {
      method: 'protein_based',
      coefficientKgPerKgFeed: TAN_PER_KG_PROTEIN * (feedProteinPercent / 100),
    };
  }
  return {
    method: 'species_coefficient',
    coefficientKgPerKgFeed: tableLookup(
      TAN_PER_KG_FEED_BY_SPECIES,
      speciesCode?.toLowerCase() ?? '',
      DEFAULT_TAN_PER_KG_FEED,
    ),
  };
}

export function feedingImpact(input: FeedingImpactInput): FeedingImpactResult {
  const salinity = input.salinityPpt ?? 0;
  const limitMgL = nh3LimitFor(input.speciesCode);
  const { method, coefficientKgPerKgFeed } = tanCoefficientFor(
    input.speciesCode,
    input.feedProteinPercent,
  );

  const producedKg = input.feedKg * coefficientKgPerKgFeed;
  const increaseMgL = (producedKg * 1_000_000) / (input.tankVolumeM3 * 1000);
  const peakMgL = (input.currentTanMgL ?? 0) + increaseMgL;

  const nh3Fraction = fractionNH3(input.currentPH, input.temperatureC, salinity);
  const peakNh3MgL = peakMgL * nh3Fraction;
  const critical = criticalPHforNH3(peakMgL, limitMgL, input.temperatureC, salinity);
  const criticalPH = Number.isNaN(critical) ? null : critical;

  const demand = o2Demand({
    dailyFeedKg: input.feedKg,
    tanKg: producedKg,
    hasBiofilter: input.hasBiofilter,
  });
  const ratePercentBw = (input.feedKg / input.biomassKg) * 100;

  return {
    tan: { method, coefficientKgPerKgFeed, producedKg, increaseMgL, peakMgL },
    ammonia: {
      nh3Fraction,
      peakNh3MgL,
      limitMgL,
      exceedsLimit: peakNh3MgL > limitMgL,
      criticalPH,
      safetyMarginPH: criticalPH === null ? null : criticalPH - input.currentPH,
      status: uiaStatus(input.currentPH, critical),
    },
    oxygen: {
      ...demand,
      consumptionRateMgLPerHour: o2ConsumptionRateMgLPerHour(
        demand.totalKgPerDay,
        input.tankVolumeM3,
      ),
    },
    feedingRate: { ratePercentBw, status: feedingRateStatus(ratePercentBw) },
  };
}
