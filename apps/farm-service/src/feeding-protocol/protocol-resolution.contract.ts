import type { FcrResolvedSource } from './entities/feeding-protocol-v2.entity';

export const PROTOCOL_RESOLUTION_CONTRACT_V1 = Object.freeze({
  schemaVersion: 'protocol-resolution/v1',
  bandBasis: Object.freeze({
    semantic: 'tank_count_weighted_average_weight_g',
    sourceCoordinate: 'TankBatch.avgWeightG',
  }),
  exactKeys: Object.freeze([
    'bandBasisWeightG',
    'bandIndex',
    'baseRatePercent',
    'effectiveRatePercent',
    'expectedFcr',
    'fcrResolvedSource',
    'feed',
    'resolvedAt',
    'schemaVersion',
    'temperatureSource',
    'tempMultiplier',
    'waterTempC',
  ] as const),
  feedExactKeys: Object.freeze(['code', 'id', 'name'] as const),
  fcrResolvedSources: Object.freeze(['override', 'band', 'matrix', 'feed'] as const),
  temperatureSources: Object.freeze(['sensor', 'manual', 'none'] as const),
});

/** Mutable current decision; immutable calculation provenance remains in snapshot. */
export interface DayPlanResolutionV1 {
  readonly schemaVersion: typeof PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion;
  readonly resolvedAt: string;
  readonly bandIndex: number;
  readonly feed: { readonly id: string; readonly code: string; readonly name: string };
  readonly baseRatePercent: number;
  readonly tempMultiplier: number;
  readonly effectiveRatePercent: number;
  readonly expectedFcr: number;
  readonly fcrResolvedSource: FcrResolvedSource;
  readonly bandBasisWeightG: number;
  readonly waterTempC: number | null;
  readonly temperatureSource: (typeof PROTOCOL_RESOLUTION_CONTRACT_V1.temperatureSources)[number];
}
