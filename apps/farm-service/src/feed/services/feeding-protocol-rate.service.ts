/**
 * FeedingProtocolRateService
 *
 * Single source of truth for turning a `FeedingProtocol` into a daily feeding
 * rate. This is the calculation the `ProtocolsTab` data was always meant to
 * drive but never did — see `docs/reviews/farm-expert/2026-07-04-*`.
 *
 * Model (factored, industry-standard band lookup):
 *
 *   feedingRatePercent = feedPercent(weightBand) × feedingMultiplier(tempBand)
 *
 * - `feedPercent` comes from the protocol's `growthStageProtocols[]` — the base
 *   % of body weight for the fish's current average weight band.
 * - `feedingMultiplier` comes from the protocol's `temperatureRanges[]` — a
 *   correction for water temperature (default 1.0 when temperature is unknown
 *   or falls outside every configured band).
 *
 * A batch assigns exactly one protocol (`Batch.protocolId`); the rate is always
 * evaluated on the TANK's average weight (mixed tanks feed on the aggregate, per
 * the combined-batch rule), so this service takes a plain `avgWeightG` and an
 * optional `waterTempC` and stays free of any batch/tank/DB dependency — which
 * keeps it pure and unit-testable.
 */
import { Injectable } from '@nestjs/common';
import type {
  FeedingProtocol,
  GrowthStageProtocol,
  TemperatureRange,
} from '../entities/feeding-protocol.entity';
import { round2 } from '../../common/utils/rounding.util';

export interface ProtocolRateResult {
  /** Final rate: base × temperature multiplier, rounded to 2 dp. */
  feedingRatePercent: number;
  /** Base % of body weight from the matched weight band. */
  baseFeedPercent: number;
  /** Temperature correction applied (1.0 when no band matched / no temp). */
  temperatureMultiplier: number;
  /** True when avgWeight fell inside a configured band (vs clamped to nearest). */
  weightBandExact: boolean;
  /** True when a temperature band actually matched the supplied temperature. */
  temperatureBandMatched: boolean;
}

function toGrams(weight: number, unit: GrowthStageProtocol['weightUnit']): number {
  return unit === 'kg' ? weight * 1000 : weight;
}

function toCelsius(temp: number, unit: TemperatureRange['unit']): number {
  return unit === 'fahrenheit' ? ((temp - 32) * 5) / 9 : temp;
}

@Injectable()
export class FeedingProtocolRateService {
  /**
   * Compute the protocol-driven feeding rate. Returns `null` only when the
   * protocol carries no usable weight bands at all — the caller then falls back
   * to its non-protocol path.
   */
  calculateRate(
    protocol: Pick<FeedingProtocol, 'growthStageProtocols' | 'temperatureRanges'>,
    avgWeightG: number,
    waterTempC?: number | null,
  ): ProtocolRateResult | null {
    const base = this.resolveFeedPercent(protocol.growthStageProtocols, avgWeightG);
    if (base === null) {
      return null;
    }
    const temp = this.resolveTemperatureMultiplier(protocol.temperatureRanges, waterTempC);
    return {
      feedingRatePercent: round2(base.feedPercent * temp.multiplier),
      baseFeedPercent: base.feedPercent,
      temperatureMultiplier: temp.multiplier,
      weightBandExact: base.exact,
      temperatureBandMatched: temp.matched,
    };
  }

  /**
   * Base feed % for the average weight. Bands are matched half-open
   * `[minWeight, maxWeight)` in grams. Weights below the lowest band clamp to
   * the lowest band, weights at/above the highest clamp to the highest — so a
   * protocol always yields a rate rather than dropping the fish to zero feed at
   * the band edges.
   */
  private resolveFeedPercent(
    bands: GrowthStageProtocol[] | undefined,
    avgWeightG: number,
  ): { feedPercent: number; exact: boolean } | null {
    if (!bands || bands.length === 0) {
      return null;
    }
    const sorted = [...bands].sort(
      (a, b) => toGrams(a.minWeight, a.weightUnit) - toGrams(b.minWeight, b.weightUnit),
    );

    const exact = sorted.find(
      (b) =>
        avgWeightG >= toGrams(b.minWeight, b.weightUnit) &&
        avgWeightG < toGrams(b.maxWeight, b.weightUnit),
    );
    if (exact) {
      return { feedPercent: exact.feedPercent, exact: true };
    }

    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    if (!lowest || !highest) {
      return null; // unreachable: sorted is non-empty here, but keeps the index access honest
    }
    if (avgWeightG < toGrams(lowest.minWeight, lowest.weightUnit)) {
      return { feedPercent: lowest.feedPercent, exact: false };
    }
    return { feedPercent: highest.feedPercent, exact: false };
  }

  /**
   * Temperature multiplier for the supplied water temperature. Ranges are
   * matched inclusive `[min, max]` (aquaculture feed tables treat the band
   * endpoints as valid). Returns 1.0 (no correction) when temperature is
   * unknown or lands outside every configured band.
   */
  private resolveTemperatureMultiplier(
    ranges: TemperatureRange[] | undefined,
    waterTempC?: number | null,
  ): { multiplier: number; matched: boolean } {
    if (waterTempC == null || !ranges || ranges.length === 0) {
      return { multiplier: 1.0, matched: false };
    }
    const match = ranges.find((r) => {
      const min = toCelsius(r.min, r.unit);
      const max = toCelsius(r.max, r.unit);
      return waterTempC >= min && waterTempC <= max;
    });
    if (!match) {
      return { multiplier: 1.0, matched: false };
    }
    return { multiplier: match.feedingMultiplier, matched: true };
  }
}
