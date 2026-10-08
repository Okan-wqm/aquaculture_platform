/**
 * The read documents of a water-chemistry measurement point — the sources at a
 * point with each channel's live status, and the inputs of a calculation
 * resolved there — and the shapes they select.
 *
 * WHY here: the farm module (binding UI, calculator) and the sensor module
 * (live monitoring) both read these two queries, and federated remotes cannot
 * import each other. One owner for the documents keeps the two views on one
 * selection; the write operations stay with their only caller (farm-module's
 * parameterSources.operations.ts). Pure strings and types, no React, no client.
 *
 * The result types are derived from the codegen schema types with `Selected`,
 * so a field that leaves the schema breaks the build instead of a view.
 */
import type {
  BoundChannelStatus,
  ChannelBindingProblem,
  MeasurementPointRef,
  ParameterReading,
  ReadingSourceKind,
  SkippedReadingCandidate,
  WaterChemistryInputStatus,
  WaterChemistryInputsResult,
  WaterQualityParamEquipment,
  WaterQualityParameterConfig,
} from '../../generated/graphql-types';

/** The selected fields of a schema type: present (the document selects them), nullable as the schema says. */
type Selected<T, K extends keyof T> = { readonly [P in K]-?: Exclude<T[P], undefined> };

/** The fields of a source row every view of a source reads (named fragment, appended to its documents). */
export const PARAMETER_SOURCE_FIELDS = `
  fragment ParameterSourceFields on WaterQualityParamEquipment {
    id
    parameterConfigId
    siteId
    systemId
    tankId
    equipmentId
    position
    depthM
    sensorId
    channelKey
    priority
    boundAt
    isActive
  }
`;

export type ParameterSourceRow = Selected<
  WaterQualityParamEquipment,
  | 'id'
  | 'parameterConfigId'
  | 'siteId'
  | 'systemId'
  | 'tankId'
  | 'equipmentId'
  | 'position'
  | 'depthM'
  | 'sensorId'
  | 'channelKey'
  | 'priority'
  | 'boundAt'
  | 'isActive'
>;

/** What kind of source a row is: its channel priority, or a manual plan line. */
export function sourceKindOf(
  source: Pick<ParameterSourceRow, 'channelKey' | 'priority'>,
): ReadingSourceKind {
  if (source.channelKey === null) return 'MANUAL';
  return source.priority === 'BACKUP' ? 'CHANNEL_BACKUP' : 'CHANNEL_PRIMARY';
}

export type SourceParameter = Selected<
  WaterQualityParameterConfig,
  'id' | 'code' | 'name' | 'unit' | 'precision' | 'chartColor' | 'quantity'
>;

export type BoundChannelResult = Selected<
  BoundChannelStatus,
  | 'sensorId'
  | 'channelKey'
  | 'presence'
  | 'sensorActive'
  | 'enabled'
  | 'quantity'
  | 'unit'
  | 'latestValue'
  | 'latestAt'
  | 'latestQuality'
  | 'calibrationDueAt'
>;

/** One live source at a point: its row with its parameter, its channel now (null: manual) and why it cannot feed. */
export interface ParameterSourceAtPoint {
  readonly source: ParameterSourceRow & { readonly parameterConfig: SourceParameter };
  readonly channel: BoundChannelResult | null;
  readonly problems: readonly ChannelBindingProblem[];
  /** The channel's newest sample carried into the parameter's unit (null: none, or not convertible). */
  readonly latestValue: number | null;
  /** The parameter's unit — the unit of latestValue. */
  readonly unit: string;
}

export interface ParameterSourcesAtPointResult {
  parameterSourcesAtPoint: ParameterSourceAtPoint[];
}

/** Every live source at a point (manual and channel), with each channel's status and problems now. */
export const PARAMETER_SOURCES_AT_POINT_QUERY = `
  query ParameterSourcesAtPoint($point: MeasurementPointInput!) {
    parameterSourcesAtPoint(point: $point) {
      source {
        ...ParameterSourceFields
        parameterConfig {
          id
          code
          name
          unit
          precision
          chartColor
          quantity
        }
      }
      channel {
        sensorId
        channelKey
        presence
        sensorActive
        enabled
        quantity
        unit
        latestValue
        latestAt
        latestQuality
        calibrationDueAt
      }
      problems
      latestValue
      unit
    }
  }
  ${PARAMETER_SOURCE_FIELDS}
`;

export type PointRefResult = Selected<MeasurementPointRef, 'kind' | 'id'>;

export type SkippedCandidateResult = Selected<
  SkippedReadingCandidate,
  | 'sourceKind'
  | 'inherited'
  | 'sensorId'
  | 'channelKey'
  | 'observedAt'
  | 'bindingProblems'
  | 'readingProblems'
>;

export type ReadingResult = Selected<
  ParameterReading,
  | 'parameterConfigId'
  | 'value'
  | 'unit'
  | 'sourceKind'
  | 'inheritedFrom'
  | 'sensorId'
  | 'channelKey'
  | 'observedAt'
  | 'ageSeconds'
  | 'quality'
  | 'unresolved'
> & {
  readonly resolvedAt: PointRefResult | null;
  readonly skipped: readonly SkippedCandidateResult[];
};

export type InputStatusResult = Selected<
  WaterChemistryInputStatus,
  | 'engineInput'
  | 'quantity'
  | 'unit'
  | 'coherenceWindow'
  | 'windowSeconds'
  | 'parameterConfigId'
  | 'problems'
> & { readonly reading: ReadingResult | null };

/** A water-chemistry calculation's inputs at a point, resolved, and its verdict. */
export type InputSetResult = Selected<
  WaterChemistryInputsResult,
  | 'set'
  | 'asOf'
  | 'verdict'
  | 'problems'
  | 'systemType'
  | 'volumeM3'
  | 'tankWaterM3'
  | 'loopSystemIds'
> & {
  readonly point: PointRefResult;
  readonly inputs: readonly InputStatusResult[];
};

export interface WaterChemistryInputsQueryResult {
  waterChemistryInputs: InputSetResult;
}

/** DOSING at a system point, TOXICITY at a tank point — each input resolved within its window. */
export const WATER_CHEMISTRY_INPUTS_QUERY = `
  query WaterChemistryInputs($point: MeasurementPointInput!, $set: WaterChemistryInputSet!) {
    waterChemistryInputs(point: $point, set: $set) {
      set
      point {
        kind
        id
      }
      asOf
      verdict
      problems
      systemType
      volumeM3
      tankWaterM3
      loopSystemIds
      inputs {
        engineInput
        quantity
        unit
        coherenceWindow
        windowSeconds
        parameterConfigId
        problems
        reading {
          parameterConfigId
          value
          unit
          sourceKind
          inheritedFrom
          resolvedAt {
            kind
            id
          }
          sensorId
          channelKey
          observedAt
          ageSeconds
          quality
          unresolved
          skipped {
            sourceKind
            inherited
            sensorId
            channelKey
            observedAt
            bindingProblems
            readingProblems
          }
        }
      }
    }
  }
`;

/**
 * The loop a tank shares, as the backend decides it (loopSystemIds, the rule
 * its inheritance applies): its one live system; none when it is in no live
 * system, AMBIGUOUS in two or more (whose water it holds is unknown).
 */
export type TankLoop =
  | { readonly kind: 'one'; readonly systemId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

export function loopOf(own: InputSetResult): TankLoop {
  const [first, ...rest] = own.loopSystemIds;
  if (first === undefined) return { kind: 'none' };
  return rest.length === 0 ? { kind: 'one', systemId: first } : { kind: 'ambiguous' };
}

/** A set whose last refresh failed: its values are shown as resolved at `asOf`. */
export interface StaleSet {
  readonly set: InputSetResult['set'];
  readonly asOf: string;
}
