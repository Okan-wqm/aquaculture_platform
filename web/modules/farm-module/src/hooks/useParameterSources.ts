/**
 * Parameter-source hooks for farm-module (FARM-HIGH-373): what feeds each
 * water-quality parameter at a measurement point, the bind / unbind / replace
 * writes, the bind's dry run, and a parameter's declared quantity.
 *
 * Reads refresh every 30 s (a channel's live status and problems are the
 * sensor service's, read on every request; there is no push for a bind made
 * elsewhere). Every write invalidates the sources, the measurement-plan
 * mappings and the parameter configs, which all read the same rows.
 */
import {
  formatPointRef,
  graphqlClient,
  loopSystemOf,
  TANK_SYSTEMS_QUERY,
  type PointSets,
  type TankSystemsResult,
  pointInput,
  PARAMETER_SOURCES_AT_POINT_QUERY,
  useTenantMutation,
  useTenantQuery,
  WATER_CHEMISTRY_INPUTS_QUERY,
  type InputSetResult,
  type ParameterSourceAtPoint,
  type ParameterSourcesAtPointResult,
  type ParameterSourceRow,
  type PointRef,
  type WaterChemistryInputsQueryResult,
} from '@aquaculture/shared-ui';
import type {
  ChannelSourcePriority,
  MeasurementPosition,
  WaterChemistryInputSet,
} from '@platform/shared-ui/generated/graphql-types';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import {
  BIND_PARAMETER_CHANNEL_MUTATION,
  CHECK_PARAMETER_CHANNEL_BINDING_QUERY,
  CLEAR_PARAMETER_QUANTITY_MUTATION,
  DECLARE_PARAMETER_QUANTITY_MUTATION,
  PARAMETER_QUANTITY_STATE_QUERY,
  REPLACE_PARAMETER_CHANNEL_MUTATION,
  SENSOR_CHANNELS_QUERY,
  UNBIND_PARAMETER_CHANNEL_MUTATION,
  type BindParameterChannelResult,
  type CheckParameterChannelBindingResult,
  type DeclaredQuantity,
  type ParameterQuantityState,
  type ParameterQuantityStateResult,
  type ReplaceParameterChannelResult,
  type SensorChannelOption,
  type SensorChannelsResult,
  type UnbindParameterChannelResult,
} from '../graphql/parameterSources.operations';

/** How often a point's sources and resolved inputs are re-read. */
export const PARAMETER_SOURCES_REFRESH_MS = 30_000;

/** Every write to a source changes these reads. */
const SOURCE_WRITE_INVALIDATES: ReadonlyArray<readonly unknown[]> = [
  ['parameterSources'],
  ['paramEquipmentMappings'],
  ['parameterConfigs'],
];

export function useParameterSourcesAtPoint(
  point: PointRef | null,
): UseQueryResult<ParameterSourceAtPoint[]> {
  return useTenantQuery(
    ['parameterSources', 'atPoint', point === null ? null : formatPointRef(point)],
    async (): Promise<ParameterSourceAtPoint[]> => {
      if (point === null) return [];
      const result = await graphqlClient.request<ParameterSourcesAtPointResult>(
        PARAMETER_SOURCES_AT_POINT_QUERY,
        { point: pointInput(point) },
      );
      return result.parameterSourcesAtPoint;
    },
    {
      enabled: point !== null,
      refetchInterval: PARAMETER_SOURCES_REFRESH_MS,
      staleTime: 10_000,
      keepPreviousData: false,
    },
  );
}

/** The calculation a point resolves: DOSING at a system, TOXICITY at a tank, none elsewhere. */
export function inputSetOfPoint(point: PointRef): WaterChemistryInputSet | null {
  if (point.kind === 'system') return 'DOSING';
  if (point.kind === 'tank') return 'TOXICITY';
  return null;
}

export function useWaterChemistryInputs(point: PointRef | null): UseQueryResult<InputSetResult> {
  const set = point === null ? null : inputSetOfPoint(point);
  return useTenantQuery(
    ['parameterSources', 'inputs', point === null ? null : formatPointRef(point), set],
    async (): Promise<InputSetResult> => {
      if (point === null || set === null) {
        throw new Error('A water-chemistry input set is resolved at a system or a tank');
      }
      const result = await graphqlClient.request<WaterChemistryInputsQueryResult>(
        WATER_CHEMISTRY_INPUTS_QUERY,
        { point: pointInput(point), set },
      );
      return result.waterChemistryInputs;
    },
    {
      enabled: set !== null,
      refetchInterval: PARAMETER_SOURCES_REFRESH_MS,
      staleTime: 10_000,
      keepPreviousData: false,
    },
  );
}

/** The loop (first system) a tank reads its carbonate state and volume from; null when it has none. */
export function useTankLoop(tankId: string | null): UseQueryResult<string | null> {
  return useTenantQuery(
    ['parameterSources', 'tankLoop', tankId],
    async (): Promise<string | null> => {
      if (tankId === null) return null;
      const result = await graphqlClient.request<TankSystemsResult>(TANK_SYSTEMS_QUERY, {
        id: tankId,
      });
      return loopSystemOf(result);
    },
    { enabled: tankId !== null, staleTime: 60_000, keepPreviousData: false },
  );
}

export interface PointSetsState {
  /** The point's own set and, for a tank, its loop's DOSING set; null until both are read. */
  sets: PointSets | null;
  loading: boolean;
  /** A read that failed (an outage is not "no value"). */
  error: Error | null;
  /** When the shown sets were resolved, and whether the last refresh failed with them on screen. */
  asOf: string | null;
  refreshFailed: boolean;
}

/**
 * What a point's calculation reads — the composition both views run
 * (composePointInputs): a system's DOSING set; a tank's TOXICITY set and its
 * loop's DOSING set.
 */
export function usePointSets(point: PointRef | null): PointSetsState {
  const own = useWaterChemistryInputs(point);
  const tankId = point !== null && point.kind === 'tank' ? point.id : null;
  const loopId = useTankLoop(tankId);
  const loopPoint: PointRef | null =
    loopId.data === undefined || loopId.data === null ? null : { kind: 'system', id: loopId.data };
  const loop = useWaterChemistryInputs(loopPoint);
  const error = own.error ?? loopId.error ?? loop.error;
  // A tank's sets are ready once its loop is known and, when it has one, read.
  const loopReady =
    tankId === null ||
    (loopId.data !== undefined && (loopId.data === null || loop.data !== undefined));
  const ready = own.data !== undefined && loopReady;
  return {
    sets:
      own.data === undefined || !ready
        ? null
        : { own: own.data, loop: loop.data === undefined ? null : loop.data },
    loading: own.isLoading || loopId.isLoading || loop.isLoading,
    error: own.data === undefined || !ready ? error : null,
    asOf: own.data === undefined ? null : own.data.asOf,
    refreshFailed: own.data !== undefined && (own.isRefetchError || loop.isRefetchError),
  };
}

/** What a bind (and its dry run) names. */
export interface ChannelBindingTarget {
  parameterConfigId: string;
  point: PointRef;
  position: MeasurementPosition;
  sensorId: string;
  channelKey: string;
  priority: ChannelSourcePriority;
}

function bindInput(target: ChannelBindingTarget): Record<string, unknown> {
  return {
    parameterConfigId: target.parameterConfigId,
    point: pointInput(target.point),
    position: target.position,
    sensorId: target.sensorId,
    channelKey: target.channelKey,
    priority: target.priority,
  };
}

/** The bind's dry run for a target (null: nothing chosen yet). Never retried: a refusal is an answer. */
export function useChannelBindingCheck(
  target: ChannelBindingTarget | null,
): UseQueryResult<CheckParameterChannelBindingResult['checkParameterChannelBinding']> {
  return useTenantQuery(
    [
      'parameterSources',
      'check',
      target === null
        ? null
        : [
            target.parameterConfigId,
            formatPointRef(target.point),
            target.position,
            target.sensorId,
            target.channelKey,
          ],
    ],
    async () => {
      if (target === null) throw new Error('No channel to check');
      const result = await graphqlClient.request<CheckParameterChannelBindingResult>(
        CHECK_PARAMETER_CHANNEL_BINDING_QUERY,
        { input: bindInput(target) },
      );
      return result.checkParameterChannelBinding;
    },
    { enabled: target !== null, retry: false, staleTime: 0, keepPreviousData: false },
  );
}

export function useSensorChannels(sensorId: string | null): UseQueryResult<SensorChannelOption[]> {
  return useTenantQuery(
    ['sensors', 'channels', sensorId],
    async (): Promise<SensorChannelOption[]> => {
      if (sensorId === null) return [];
      const result = await graphqlClient.request<SensorChannelsResult>(SENSOR_CHANNELS_QUERY, {
        sensorId,
      });
      return [...result.dataChannelsBySensor].sort((a, b) => a.displayOrder - b.displayOrder);
    },
    { enabled: sensorId !== null, staleTime: 30_000, keepPreviousData: false },
  );
}

export function useParameterQuantityState(
  parameterConfigId: string | null,
): UseQueryResult<ParameterQuantityState | null> {
  return useTenantQuery(
    ['parameterConfigs', 'quantityState', parameterConfigId],
    async (): Promise<ParameterQuantityState | null> => {
      if (parameterConfigId === null) return null;
      const result = await graphqlClient.request<ParameterQuantityStateResult>(
        PARAMETER_QUANTITY_STATE_QUERY,
        { id: parameterConfigId },
      );
      return result.parameterConfig;
    },
    { enabled: parameterConfigId !== null, staleTime: 10_000, keepPreviousData: false },
  );
}

export function useBindParameterChannel(): UseMutationResult<
  ParameterSourceRow,
  Error,
  ChannelBindingTarget
> {
  return useTenantMutation(
    async (target: ChannelBindingTarget): Promise<ParameterSourceRow> => {
      const result = await graphqlClient.request<BindParameterChannelResult>(
        BIND_PARAMETER_CHANNEL_MUTATION,
        { input: bindInput(target) },
      );
      return result.bindParameterChannel;
    },
    { invalidate: SOURCE_WRITE_INVALIDATES },
  );
}

export function useUnbindParameterChannel(): UseMutationResult<
  UnbindParameterChannelResult['unbindParameterChannel'],
  Error,
  string
> {
  return useTenantMutation(
    async (sourceId: string) => {
      const result = await graphqlClient.request<UnbindParameterChannelResult>(
        UNBIND_PARAMETER_CHANNEL_MUTATION,
        { sourceId },
      );
      return result.unbindParameterChannel;
    },
    { invalidate: SOURCE_WRITE_INVALIDATES },
  );
}

export interface ReplaceChannelInput {
  sourceId: string;
  sensorId: string;
  channelKey: string;
}

export function useReplaceParameterChannel(): UseMutationResult<
  ParameterSourceRow,
  Error,
  ReplaceChannelInput
> {
  return useTenantMutation(
    async (input: ReplaceChannelInput): Promise<ParameterSourceRow> => {
      const result = await graphqlClient.request<ReplaceParameterChannelResult>(
        REPLACE_PARAMETER_CHANNEL_MUTATION,
        { input },
      );
      return result.replaceParameterChannel;
    },
    { invalidate: SOURCE_WRITE_INVALIDATES },
  );
}

export function useDeclareParameterQuantity(): UseMutationResult<
  DeclaredQuantity,
  Error,
  { parameterConfigId: string; quantity: string }
> {
  return useTenantMutation(
    async (input: { parameterConfigId: string; quantity: string }): Promise<DeclaredQuantity> => {
      const result = await graphqlClient.request<{ declareParameterQuantity: DeclaredQuantity }>(
        DECLARE_PARAMETER_QUANTITY_MUTATION,
        { input },
      );
      return result.declareParameterQuantity;
    },
    { invalidate: SOURCE_WRITE_INVALIDATES },
  );
}

export function useClearParameterQuantity(): UseMutationResult<DeclaredQuantity, Error, string> {
  return useTenantMutation(
    async (parameterConfigId: string): Promise<DeclaredQuantity> => {
      const result = await graphqlClient.request<{ clearParameterQuantity: DeclaredQuantity }>(
        CLEAR_PARAMETER_QUANTITY_MUTATION,
        { parameterConfigId },
      );
      return result.clearParameterQuantity;
    },
    { invalidate: SOURCE_WRITE_INVALIDATES },
  );
}
