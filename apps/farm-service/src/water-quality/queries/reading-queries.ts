/**
 * Reading side of the water-chemistry channel binding (plan rev2 PR-4, D2,
 * D3, D12): what a parameter reads at a point now, and whether a
 * water-chemistry calculation can run there.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

import type { WaterChemistryInputSet } from '../data/water-chemistry-input-sets';
import type { MeasurementPoint, SourceLocation } from '../services/parameter-sources';

import type { SourceReader } from './parameter-source-queries';

/** The value of one parameter at a location now, with where it came from and what was passed over. */
export class ResolveParameterValueQuery implements ITenantQuery {
  readonly queryName = 'ResolveParameterValueQuery';

  constructor(
    public readonly tenantId: string,
    public readonly parameterConfigId: string,
    public readonly location: SourceLocation,
    /** Skip a value older than this; null accepts any age. */
    public readonly maxAgeMs: number | null,
    public readonly caller: SourceReader,
  ) {}
}

/** The inputs of a water-chemistry calculation at a point, each resolved, and the set's verdict. */
export class ResolveWaterChemistryInputsQuery implements ITenantQuery {
  readonly queryName = 'ResolveWaterChemistryInputsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly point: MeasurementPoint,
    public readonly set: WaterChemistryInputSet,
    public readonly caller: SourceReader,
  ) {}
}
