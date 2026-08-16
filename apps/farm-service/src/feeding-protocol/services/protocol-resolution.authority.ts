import { Injectable } from '@nestjs/common';
import { mutationInstantIsoV1, type MutationInstantV1 } from '@aquaculture/backend-common/database';

import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';
import type { DayPlanResolutionV1 } from '../entities/feeding-day-plan.entity';
import type {
  FcrMatrix,
  FeedingProtocolV2,
  ProtocolBand,
} from '../entities/feeding-protocol-v2.entity';
import type { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { ProtocolRateService, type ResolvedBand } from './protocol-rate.service';
import { round3 } from '../../common/utils/rounding.util';
import { PROTOCOL_RESOLUTION_CONTRACT_V1 } from '../protocol-resolution.contract';

export const PROTOCOL_RESOLUTION_AUTHORITY_REVISION = PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion;

export interface ProtocolResolutionInputV1 {
  readonly protocol: Pick<
    FeedingProtocolV2,
    'bands' | 'temperatureAdjustments' | 'fcrMatrix' | 'settings'
  >;
  readonly assignment: Pick<ProtocolAssignment, 'overrides' | 'currentBandIndex' | 'currentFeedId'>;
  readonly bandBasisWeightG: number;
  readonly temperature: EffectiveTemperature;
  readonly feedFcrMatrixByFeedId?: ReadonlyMap<string, FcrMatrix>;
  readonly mutationInstant: MutationInstantV1;
  /** Manual transition recalc pins the operator-selected current band once. */
  readonly bandSelection?: 'policy' | 'pinned_current';
}

export interface ProtocolResolutionResultV1 extends DayPlanResolutionV1 {
  readonly band: ProtocolBand;
  readonly bandChanged: boolean;
  readonly previousBandIndex: number | null;
}

/** Exact persistence/API projection; internal decision diagnostics never leak into JSONB. */
export function projectDayPlanResolutionV1(
  resolution: ProtocolResolutionResultV1,
): DayPlanResolutionV1 {
  return Object.freeze({
    schemaVersion: resolution.schemaVersion,
    resolvedAt: resolution.resolvedAt,
    bandIndex: resolution.bandIndex,
    feed: Object.freeze({ ...resolution.feed }),
    baseRatePercent: resolution.baseRatePercent,
    tempMultiplier: resolution.tempMultiplier,
    effectiveRatePercent: resolution.effectiveRatePercent,
    expectedFcr: resolution.expectedFcr,
    fcrResolvedSource: resolution.fcrResolvedSource,
    bandBasisWeightG: resolution.bandBasisWeightG,
    waterTempC: resolution.waterTempC,
    temperatureSource: resolution.temperatureSource,
  });
}

/** The sole band → feed → rate → expected-FCR decision authority. */
@Injectable()
export class ProtocolResolutionAuthority {
  constructor(private readonly rateService: ProtocolRateService) {}

  resolveBandBasisWeight(unit: { readonly avgWeightG: number }): number {
    const value = Number(unit.avgWeightG);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Band basis weight must be finite and non-negative');
    }
    return value;
  }

  resolve(input: ProtocolResolutionInputV1): ProtocolResolutionResultV1 | null {
    const weightResolved = this.rateService.bandFor(input.protocol.bands, input.bandBasisWeightG);
    if (!weightResolved) return null;

    const previousBandIndex = input.assignment.currentBandIndex ?? null;
    const selected = this.selectBand(input, weightResolved, previousBandIndex);
    const tempMultiplier = this.rateService.temperatureMultiplier(
      input.protocol.temperatureAdjustments,
      input.temperature.celsius,
    );
    const effectiveRatePercent = this.rateService.effectiveRatePercent({
      baseRatePercent: selected.band.feedingRatePercent,
      temperatureMultiplier: tempMultiplier,
      rateAdjustmentPercent: input.assignment.overrides?.rateAdjustmentPercent,
      minRatePercent: input.protocol.settings.minFeedingRatePercent,
      maxRatePercent: input.protocol.settings.maxFeedingRatePercent,
    });
    const expectedFcr = this.rateService.resolveExpectedFcr({
      band: selected.band,
      fcrSource: input.protocol.settings.fcrSource,
      avgWeightG: input.bandBasisWeightG,
      temperatureC: input.temperature.celsius,
      protocolFcrMatrix: input.protocol.fcrMatrix,
      feedFcrMatrix: input.feedFcrMatrixByFeedId?.get(selected.band.feedId),
      fcrOverrides: input.assignment.overrides?.fcrOverrides,
    });

    return {
      schemaVersion: PROTOCOL_RESOLUTION_AUTHORITY_REVISION,
      resolvedAt: mutationInstantIsoV1(input.mutationInstant),
      bandIndex: selected.index,
      feed: {
        id: selected.band.feedId,
        code: selected.band.feedCode,
        name: selected.band.feedName,
      },
      baseRatePercent: selected.band.feedingRatePercent,
      tempMultiplier,
      effectiveRatePercent: round3(effectiveRatePercent),
      expectedFcr: expectedFcr.value,
      fcrResolvedSource: expectedFcr.source,
      bandBasisWeightG: round3(input.bandBasisWeightG),
      waterTempC: input.temperature.celsius,
      temperatureSource: input.temperature.source,
      band: selected.band,
      bandChanged: previousBandIndex !== null && selected.index !== previousBandIndex,
      previousBandIndex,
    };
  }

  resolveManualTransitionBand(
    bands: readonly ProtocolBand[],
    bandBasisWeightG: number,
    toFeedId: string,
  ): number | null {
    const weightResolved = this.rateService.bandFor([...bands], bandBasisWeightG);
    if (!weightResolved) return null;
    const candidates = [weightResolved.index, weightResolved.index - 1, weightResolved.index + 1];
    for (const index of candidates) {
      if (index >= 0 && index < bands.length && bands[index]?.feedId === toFeedId) return index;
    }
    return null;
  }

  private selectBand(
    input: ProtocolResolutionInputV1,
    weightResolved: ResolvedBand,
    previousBandIndex: number | null,
  ): ResolvedBand {
    const currentBand =
      previousBandIndex === null ? undefined : input.protocol.bands[previousBandIndex];
    if (
      input.bandSelection === 'pinned_current' ||
      input.protocol.settings.autoTransition === false
    ) {
      return currentBand ? { band: currentBand, index: previousBandIndex! } : weightResolved;
    }
    if (previousBandIndex === null || !currentBand || weightResolved.index === previousBandIndex) {
      return weightResolved;
    }

    const buffer = input.protocol.settings.transitionBufferG ?? 0;
    if (
      weightResolved.index > previousBandIndex &&
      input.bandBasisWeightG >= weightResolved.band.minWeightG + buffer
    ) {
      return weightResolved;
    }
    if (
      weightResolved.index < previousBandIndex &&
      input.bandBasisWeightG <= weightResolved.band.maxWeightG - buffer
    ) {
      return weightResolved;
    }
    return { band: currentBand, index: previousBandIndex };
  }
}
