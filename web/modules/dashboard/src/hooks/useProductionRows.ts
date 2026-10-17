/**
 * The Production dashboard's site rows (model/production for what each cell
 * reads and why).
 *
 * WHAT: the viewer's active sites, then per site — in parallel — its gateways,
 * its day plans of the site's local day and its systems; once the plans name
 * the units, the units' effective temperatures and their dissolved oxygen
 * (farm's reading resolver, one request per site for all its units); plus the
 * tenant's dissolved-oxygen parameter and the farm module's open alarms per
 * site. Each cell keeps its own source's state, and a cell read after another
 * source fails with it (flatMapCell). Every query refreshes with the site
 * list (SITE_REFRESH_MS).
 *
 * WHY per-site requests: each farm read is site-filtered server-side, and the
 * unit reads are refused for a module user unless every unit is on one of
 * their sites — asking per site keeps each request inside one site.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { bothOf, cellAt, cellOf, flatMapCell, mapCell, type Cell } from '../model/cell';
import { localDateIn } from '../model/format';
import {
  dataFreshness,
  feedProgress,
  lowestOxygen,
  OXYGEN_MAX_AGE_SECONDS,
  oxygenParameterOf,
  plannedUnitIds,
  tankCountOf,
  temperatureOf,
  unitCodesOf,
  type DayPlanRecord,
  type GatewayRecord,
  type OxygenParameter,
  type OxygenState,
  type ProductionSiteRow,
  type UnitReadingRecord,
  type UnitTemperatureRecord,
} from '../model/production';
import type { DashboardSite } from '../model/site';
import { tallyOf } from '../model/alarms';

import {
  PARAMETER_LIMITS_QUERY,
  SITE_DAY_PLANS_QUERY,
  SITE_GATEWAYS_QUERY,
  SITE_SYSTEMS_QUERY,
  UNIT_OXYGEN_QUERY,
  UNIT_TEMPERATURES_QUERY,
  type DashboardOperationResults,
} from './dashboard.operations';
import { SITE_REFRESH_MS, useActiveSites } from './useActiveSites';
import { useSiteAlarmTallies } from './useSiteAlarmTallies';
import { useTenantKeys } from './useTenantKeys';

const NO_READINGS: readonly UnitReadingRecord[] = [];

export interface SiteRows<Row> {
  readonly sites: UseQueryResult<readonly DashboardSite[]>;
  readonly rows: readonly Row[];
}

const REFRESH = { staleTime: SITE_REFRESH_MS, refetchInterval: SITE_REFRESH_MS } as const;

export function useSiteGateways(
  sites: readonly DashboardSite[],
): UseQueryResult<readonly GatewayRecord[]>[] {
  const { key, session } = useTenantKeys();
  return useQueries({
    queries: sites.map((site) => ({
      queryKey: key('siteGateways', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly GatewayRecord[]> =>
        (
          await graphqlClient.request<DashboardOperationResults['DashboardSiteGateways']>(
            SITE_GATEWAYS_QUERY,
            { siteId: site.id },
            { signal },
          )
        ).edgeDevices.items,
      enabled: session,
      ...REFRESH,
    })),
  });
}

function useOxygenParameter(): UseQueryResult<OxygenParameter | null> {
  return useTenantQuery(
    ['dashboard', 'parameterLimits'],
    async ({ signal }): Promise<OxygenParameter | null> => {
      const data = await graphqlClient.request<
        DashboardOperationResults['DashboardParameterLimits']
      >(PARAMETER_LIMITS_QUERY, {}, { signal });
      return oxygenParameterOf(data.parameterConfigs);
    },
    REFRESH,
  );
}

/** What a site's oxygen cell is read from: the parameter, and the units' readings (none to ask for, or asked). */
interface OxygenSource {
  readonly parameter: OxygenParameter | null;
  readonly readings: readonly UnitReadingRecord[];
}

function oxygenStateOf(
  source: OxygenSource,
  unitIds: readonly string[],
  codes: ReadonlyMap<string, string>,
): OxygenState {
  if (source.parameter === null) return { kind: 'noParameter' };
  if (unitIds.length === 0) return { kind: 'noUnits' };
  return lowestOxygen(source.readings, codes, source.parameter);
}

export function useProductionRows(): SiteRows<ProductionSiteRow> {
  const { key, session } = useTenantKeys();
  const sites = useActiveSites();
  const list = sites.data ?? [];
  const tallies = useSiteAlarmTallies('FARM');
  const parameter = useOxygenParameter();
  const gateways = useSiteGateways(list);

  const plans = useQueries({
    queries: list.map((site) => ({
      queryKey: key('siteDayPlans', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly DayPlanRecord[]> =>
        (
          await graphqlClient.request<DashboardOperationResults['DashboardSiteDayPlans']>(
            SITE_DAY_PLANS_QUERY,
            { siteId: site.id, planDate: localDateIn(new Date(), site.timezone) },
            { signal },
          )
        ).feedingDayPlans,
      enabled: session,
      ...REFRESH,
    })),
  });

  const systems = useQueries({
    queries: list.map((site) => ({
      queryKey: key('siteSystems', site.id),
      queryFn: async ({
        signal,
      }: {
        signal: AbortSignal;
      }): Promise<DashboardOperationResults['DashboardSiteSystems']['systems']['items']> =>
        (
          await graphqlClient.request<DashboardOperationResults['DashboardSiteSystems']>(
            SITE_SYSTEMS_QUERY,
            { siteId: site.id },
            { signal },
          )
        ).systems.items,
      enabled: session,
      ...REFRESH,
    })),
  });

  const unitIdsBySite = list.map((_, index) => plannedUnitIds(plans[index]?.data ?? []));

  const temperatures = useQueries({
    queries: list.map((site, index) => {
      const unitIds = unitIdsBySite[index] ?? [];
      return {
        queryKey: key('unitTemperatures', site.id, unitIds),
        queryFn: async ({
          signal,
        }: {
          signal: AbortSignal;
        }): Promise<readonly UnitTemperatureRecord[]> =>
          (
            await graphqlClient.request<DashboardOperationResults['DashboardUnitTemperatures']>(
              UNIT_TEMPERATURES_QUERY,
              { unitIds },
              { signal },
            )
          ).effectiveUnitTemperatures,
        enabled: session && unitIds.length > 0,
        ...REFRESH,
      };
    }),
  });

  // The parameter is known once its query answered and found one (null: none configured).
  const parameterId =
    parameter.data === undefined || parameter.data === null ? null : parameter.data.id;
  const oxygen = useQueries({
    queries: list.map((site, index) => {
      const unitIds = unitIdsBySite[index] ?? [];
      return {
        queryKey: key('unitOxygen', site.id, parameterId, unitIds),
        queryFn: async ({
          signal,
        }: {
          signal: AbortSignal;
        }): Promise<readonly UnitReadingRecord[]> =>
          (
            await graphqlClient.request<DashboardOperationResults['DashboardUnitOxygen']>(
              UNIT_OXYGEN_QUERY,
              {
                input: {
                  parameterConfigId: parameterId,
                  unitIds,
                  maxAgeSeconds: OXYGEN_MAX_AGE_SECONDS,
                },
              },
              { signal },
            )
          ).resolvedUnitParameterValues,
        enabled: session && parameterId !== null && unitIds.length > 0,
        ...REFRESH,
      };
    }),
  });

  const now = new Date();
  const rows = list.map((site, index): ProductionSiteRow => {
    const unitIds = unitIdsBySite[index] ?? [];
    const planCell = cellAt(plans, index, (data: readonly DayPlanRecord[]) => data);
    const codes =
      planCell.status === 'ready' ? unitCodesOf(planCell.value) : new Map<string, string>();
    // The units' reads wait for the plans that name them, and fail with them.
    const temperatureCell = flatMapCell(
      planCell,
      (): Cell<readonly UnitTemperatureRecord[]> =>
        unitIds.length === 0
          ? { status: 'ready', value: [] }
          : cellAt(temperatures, index, (data: readonly UnitTemperatureRecord[]) => data),
    );
    const oxygenSource = flatMapCell(planCell, () =>
      flatMapCell(
        cellOf(parameter, (value: OxygenParameter | null) => value),
        (value): Cell<OxygenSource> =>
          value === null || unitIds.length === 0
            ? { status: 'ready', value: { parameter: value, readings: NO_READINGS } }
            : cellAt(oxygen, index, (readings: readonly UnitReadingRecord[]) => ({
                parameter: value,
                readings,
              })),
      ),
    );
    const gatewayCell = cellAt(gateways, index, (data: readonly GatewayRecord[]) => data);
    return {
      siteId: site.id,
      code: site.code,
      name: site.name,
      type: site.type,
      tankCount: cellAt(systems, index, tankCountOf),
      data: bothOf(gatewayCell, oxygenSource, (gatewayList, source) =>
        dataFreshness(
          gatewayList,
          source.readings.map((reading) => reading.observedAt),
          now,
        ),
      ),
      alarms: cellOf(tallies, (map) => tallyOf(map, site.id)),
      oxygen: mapCell(oxygenSource, (source) => oxygenStateOf(source, unitIds, codes)),
      temperature: mapCell(temperatureCell, (data) => temperatureOf(data, codes)),
      feed: mapCell(planCell, (data) => feedProgress(data, now)),
    };
  });

  return { sites, rows };
}
