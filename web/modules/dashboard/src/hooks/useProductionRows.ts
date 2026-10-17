/**
 * The Production dashboard's site rows (model/production for what each cell
 * reads and why).
 *
 * WHAT: the viewer's active sites, then per site — in parallel — its gateways,
 * its last day of water-quality measurements, its day plans of the site's
 * local day, its systems and, once the plans name the units, the units'
 * effective temperatures; plus the tenant's dissolved-oxygen limits and the
 * farm module's open alarms per site. Each cell keeps its own source's state.
 * Every query refreshes with the site list (SITE_REFRESH_MS).
 *
 * WHY per-site requests: each farm read is site-filtered server-side, and the
 * unit temperatures are refused for a module user unless every unit is on one
 * of their sites — asking per site keeps each request inside one site.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { bothOf, cellAt, cellOf, mapCell, type Cell } from '../model/cell';
import { localDateIn } from '../model/format';
import {
  dataFreshness,
  feedProgress,
  lowestOxygen,
  oxygenLimitOf,
  tankCountOf,
  temperatureOf,
  unitCodesOf,
  type DayPlanRecord,
  type GatewayRecord,
  type MeasurementRecord,
  type OxygenLimit,
  type ProductionSiteRow,
  type UnitTemperatureRecord,
} from '../model/production';
import { tallyOf } from '../model/alarms';

import {
  PARAMETER_LIMITS_QUERY,
  SITE_DAY_PLANS_QUERY,
  SITE_GATEWAYS_QUERY,
  SITE_MEASUREMENTS_QUERY,
  SITE_SYSTEMS_QUERY,
  UNIT_TEMPERATURES_QUERY,
} from './dashboard.operations';
import { SITE_REFRESH_MS, useActiveSites, type DashboardSite } from './useActiveSites';
import { useSiteAlarmTallies } from './useSiteAlarmTallies';
import { useTenantKeys } from './useTenantKeys';

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_CODES: ReadonlyMap<string, string> = new Map();

function identity<T>(value: T): T {
  return value;
}

export interface SiteRows<Row> {
  readonly sites: UseQueryResult<readonly DashboardSite[]>;
  readonly rows: readonly Row[];
}

const REFRESH = { staleTime: SITE_REFRESH_MS, refetchInterval: SITE_REFRESH_MS } as const;

async function request<T>(
  document: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  return graphqlClient.request<T>(document, variables, { signal });
}

export function useSiteGateways(
  sites: readonly DashboardSite[],
): UseQueryResult<readonly GatewayRecord[]>[] {
  const { key, session } = useTenantKeys();
  return useQueries({
    queries: sites.map((site) => ({
      queryKey: key('siteGateways', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly GatewayRecord[]> =>
        (
          await request<{ edgeDevices: { items: GatewayRecord[] } }>(
            SITE_GATEWAYS_QUERY,
            { siteId: site.id },
            signal,
          )
        ).edgeDevices.items,
      enabled: session,
      ...REFRESH,
    })),
  });
}

function useOxygenLimit(): UseQueryResult<OxygenLimit | null> {
  return useTenantQuery(
    ['dashboard', 'parameterLimits'],
    async ({ signal }): Promise<OxygenLimit | null> => {
      const data = await request<{
        parameterConfigs: {
          code: string;
          criticalMin: number | null;
          warningMin: number | null;
        }[];
      }>(PARAMETER_LIMITS_QUERY, {}, signal);
      return oxygenLimitOf(data.parameterConfigs);
    },
    REFRESH,
  );
}

export function useProductionRows(): SiteRows<ProductionSiteRow> {
  const { key, session } = useTenantKeys();
  const sites = useActiveSites();
  const list = sites.data ?? [];
  const tallies = useSiteAlarmTallies('FARM');
  const limit = useOxygenLimit();
  const gateways = useSiteGateways(list);

  const measurements = useQueries({
    queries: list.map((site) => ({
      queryKey: key('siteMeasurements', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly MeasurementRecord[]> =>
        (
          await request<{ waterQualityMeasurements: { items: MeasurementRecord[] } }>(
            SITE_MEASUREMENTS_QUERY,
            { siteId: site.id, fromDate: new Date(Date.now() - DAY_MS).toISOString() },
            signal,
          )
        ).waterQualityMeasurements.items,
      enabled: session,
      ...REFRESH,
    })),
  });

  const plans = useQueries({
    queries: list.map((site) => ({
      queryKey: key('siteDayPlans', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly DayPlanRecord[]> =>
        (
          await request<{ feedingDayPlans: DayPlanRecord[] }>(
            SITE_DAY_PLANS_QUERY,
            { siteId: site.id, planDate: localDateIn(new Date(), site.timezone) },
            signal,
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
      }): Promise<readonly { tankCount: number | null }[]> =>
        (
          await request<{ systems: { items: { tankCount: number | null }[] } }>(
            SITE_SYSTEMS_QUERY,
            { siteId: site.id },
            signal,
          )
        ).systems.items,
      enabled: session,
      ...REFRESH,
    })),
  });

  const unitIdsBySite = list.map((_, index) =>
    [...new Set((plans[index]?.data ?? []).map((plan) => plan.unitId))].sort(),
  );
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
            await request<{ effectiveUnitTemperatures: UnitTemperatureRecord[] }>(
              UNIT_TEMPERATURES_QUERY,
              { unitIds },
              signal,
            )
          ).effectiveUnitTemperatures,
        enabled: session && unitIds.length > 0,
        ...REFRESH,
      };
    }),
  });

  const now = new Date();
  const rows = list.map((site, index): ProductionSiteRow => {
    const planCell = cellAt(plans, index, (data: readonly DayPlanRecord[]) => data);
    const codes = planCell.status === 'ready' ? unitCodesOf(planCell.value) : NO_CODES;
    const temperatureCell: Cell<readonly UnitTemperatureRecord[]> =
      planCell.status === 'ready' && (unitIdsBySite[index] ?? []).length === 0
        ? { status: 'ready', value: [] }
        : cellAt(temperatures, index, (data: readonly UnitTemperatureRecord[]) => data);
    const measurementCell = cellAt(
      measurements,
      index,
      (data: readonly MeasurementRecord[]) => data,
    );
    const gatewayCell = cellAt(gateways, index, (data: readonly GatewayRecord[]) => data);
    return {
      siteId: site.id,
      code: site.code,
      name: site.name,
      type: site.type,
      tankCount: cellAt(systems, index, tankCountOf),
      data: bothOf(gatewayCell, measurementCell, (g, m) => dataFreshness(g, m, now)),
      alarms: cellOf(tallies, (map) => tallyOf(map, site.id)),
      oxygen: bothOf(measurementCell, cellOf(limit, identity), (data, value) =>
        lowestOxygen(data, codes, value),
      ),
      temperature: mapCell(temperatureCell, (data) => temperatureOf(data, codes)),
      feed: mapCell(planCell, feedProgress),
    };
  });

  return { sites, rows };
}
