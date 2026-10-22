/**
 * Protocol day-step — the ONE simulation core shared by every forward-looking
 * feeding projection (SSoT, design record 2026-10-19).
 *
 * Both the feed forecast (procurement demand) and the production plan's tank
 * growth projection walk the same per-day physics; before this helper the two
 * loops had drifted (the projection inlined the rate adjustment without the
 * min/max clamps and without the feed-product FCR matrix). Everything that is
 * per-day physics lives HERE; everything domain-specific (survival decay,
 * harvest fractions, feed transitions, capacity fill) stays with the caller.
 */
import type {
  FcrMatrix,
  FeedingProtocolV2,
  ProtocolBand,
} from '../entities/feeding-protocol-v2.entity';
import type { FcrOverride } from '../entities/protocol-assignment.entity';
import { ProtocolRateService } from './protocol-rate.service';

export interface ProtocolDayStepInput {
  protocol: Pick<FeedingProtocolV2, 'bands' | 'temperatureAdjustments' | 'fcrMatrix' | 'settings'>;
  band: ProtocolBand;
  avgWeightG: number;
  biomassKg: number;
  fishCount: number;
  temperatureC: number | null;
  /** Assignment overrides (R11): ±% on the rate, per-feed FCR pins. */
  rateAdjustmentPercent?: number;
  fcrOverrides?: FcrOverride[];
  /** Feed-product FCR matrix (fcrSource=feed resolves through this). */
  feedFcrMatrix?: FcrMatrix | null;
}

export interface ProtocolDayStepResult {
  feedId: string;
  ratePercent: number;
  feedKg: number;
  expectedFcr: number;
  growthKg: number;
  nextBiomassKg: number;
  nextAvgWeightG: number;
}

/**
 * One simulated day under the protocol: rate × biomass = feed;
 * feed ÷ expected FCR = growth; growth walks biomass and average weight.
 */
export function simulateProtocolDay(
  rateService: ProtocolRateService,
  input: ProtocolDayStepInput,
): ProtocolDayStepResult {
  const tempMultiplier = rateService.temperatureMultiplier(
    input.protocol.temperatureAdjustments,
    input.temperatureC,
  );
  const ratePercent = rateService.effectiveRatePercent({
    baseRatePercent: input.band.feedingRatePercent,
    temperatureMultiplier: tempMultiplier,
    rateAdjustmentPercent: input.rateAdjustmentPercent,
    minRatePercent: input.protocol.settings.minFeedingRatePercent,
    maxRatePercent: input.protocol.settings.maxFeedingRatePercent,
  });
  const feedKg = (input.biomassKg * ratePercent) / 100;

  const fcr = rateService.resolveExpectedFcr({
    band: input.band,
    fcrSource: input.protocol.settings.fcrSource ?? 'band',
    avgWeightG: input.avgWeightG,
    temperatureC: input.temperatureC,
    protocolFcrMatrix: input.protocol.fcrMatrix,
    feedFcrMatrix: input.feedFcrMatrix ?? undefined,
    fcrOverrides: input.fcrOverrides,
  }).value;

  const growthKg = fcr > 0 ? feedKg / fcr : 0;
  const nextBiomassKg = input.biomassKg + growthKg;
  const nextAvgWeightG =
    input.fishCount > 0 ? (nextBiomassKg * 1000) / input.fishCount : input.avgWeightG;

  return {
    feedId: input.band.feedId,
    ratePercent,
    feedKg,
    expectedFcr: fcr,
    growthKg,
    nextBiomassKg,
    nextAvgWeightG,
  };
}
