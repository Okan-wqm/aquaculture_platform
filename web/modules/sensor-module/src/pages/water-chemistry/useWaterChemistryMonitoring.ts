/**
 * Data of the water-chemistry monitoring view: the farm topology it is laid
 * out by, the sources at a point with each channel's live status, and the
 * calculation inputs resolved at each point. Everything is the backend's —
 * nothing is kept in the browser but the chart-type choice.
 *
 * Sources and inputs are re-read every 30 s (a channel's status is read live
 * on each request; a bind made in the farm Sources tab shows up on the next
 * read).
 */
import {
  createTenantQueryKey,
  formatPointRef,
  PARAMETER_SOURCES_AT_POINT_QUERY,
  pointInput,
  useAuth,
  useTenantQuery,
  WATER_CHEMISTRY_INPUTS_QUERY,
  type InputSetResult,
  type ParameterSourceAtPoint,
  type ParameterSourcesAtPointResult,
  type PointRef,
  type WaterChemistryInputsQueryResult,
} from '@aquaculture/shared-ui';
import type { WaterChemistryInputSet } from '@platform/shared-ui/generated/graphql-types';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { graphqlFetch } from '../../config/api';
import {
  WC_SYSTEM_TANKS_QUERY,
  WC_SYSTEMS_QUERY,
  WC_TANK_SYSTEMS_QUERY,
  type WcTankSystemsResult,
  type WcSystem,
  type WcSystemsResult,
  type WcSystemTanksResult,
  type WcTank,
} from '../../graphql/waterChemistry.queries';

export const WC_REFRESH_MS = 30_000;

const PAGE = { page: 1, limit: 100 };

export function useWcSystemList(): UseQueryResult<WcSystem[]> {
  return useTenantQuery(
    ['waterChemistry', 'systems'],
    async (): Promise<WcSystem[]> => {
      const result = await graphqlFetch<WcSystemsResult>(WC_SYSTEMS_QUERY, { pagination: PAGE });
      return result.systems.items;
    },
    { staleTime: 60_000 },
  );
}

export function useSystemTanks(systemId: string | null): UseQueryResult<WcTank[]> {
  return useTenantQuery(
    ['waterChemistry', 'systemTanks', systemId],
    async (): Promise<WcTank[]> => {
      if (systemId === null) return [];
      const result = await graphqlFetch<WcSystemTanksResult>(WC_SYSTEM_TANKS_QUERY, {
        systemId,
        pagination: PAGE,
      });
      return result.equipmentList.items;
    },
    { enabled: systemId !== null, staleTime: 60_000, keepPreviousData: false },
  );
}

/**
 * The tab a tank-scoped link opens: the tank's first system, null when it has
 * none. Navigation only — which loop a tank READS is the backend's
 * loopSystemIds (none when it is in two or more).
 */
export function useTankSystem(tankId: string | null): UseQueryResult<string | null> {
  return useTenantQuery(
    ['waterChemistry', 'tankSystem', tankId],
    async (): Promise<string | null> => {
      if (tankId === null) return null;
      const result = await graphqlFetch<WcTankSystemsResult>(WC_TANK_SYSTEMS_QUERY, { id: tankId });
      const systemIds = result.equipment === null ? null : result.equipment.systemIds;
      const [first] = systemIds === null ? [] : systemIds;
      return first === undefined ? null : first;
    },
    { enabled: tankId !== null, staleTime: 60_000 },
  );
}

export function usePointSources(point: PointRef): UseQueryResult<ParameterSourceAtPoint[]> {
  return useTenantQuery(
    ['waterChemistry', 'sources', formatPointRef(point)],
    async (): Promise<ParameterSourceAtPoint[]> => {
      const result = await graphqlFetch<ParameterSourcesAtPointResult>(
        PARAMETER_SOURCES_AT_POINT_QUERY,
        { point: pointInput(point) },
      );
      return result.parameterSourcesAtPoint;
    },
    { refetchInterval: WC_REFRESH_MS, staleTime: 10_000, keepPreviousData: false },
  );
}

export interface PointSetRequest {
  point: PointRef;
  set: WaterChemistryInputSet;
}

/**
 * The resolved inputs of several points at once (the system's overlay draws
 * every point on one chart), in request order; each entry is undefined until
 * its answer arrives. Keyed like useTenantQuery: tenant prefix, authenticated
 * session only.
 */
export function usePointInputSets(
  requests: readonly PointSetRequest[],
): Array<UseQueryResult<InputSetResult>> {
  const { token, tenantId } = useAuth();
  const authenticatedTenantId = token && tenantId ? tenantId : null;
  return useQueries({
    queries: requests.map((request) => ({
      queryKey: createTenantQueryKey(
        authenticatedTenantId,
        'waterChemistry',
        'inputs',
        formatPointRef(request.point),
        request.set,
      ),
      queryFn: async (): Promise<InputSetResult> => {
        const result = await graphqlFetch<WaterChemistryInputsQueryResult>(
          WATER_CHEMISTRY_INPUTS_QUERY,
          { point: pointInput(request.point), set: request.set },
        );
        return result.waterChemistryInputs;
      },
      enabled: authenticatedTenantId !== null,
      refetchInterval: WC_REFRESH_MS,
      staleTime: 10_000,
    })),
  });
}
