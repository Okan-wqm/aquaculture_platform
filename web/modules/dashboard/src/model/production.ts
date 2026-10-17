/**
 * Production dashboard: one fish site's row of the Site status table.
 *
 * WHY these sources (each a real record, none estimated):
 *  - data freshness: the newest of the site's gateways' reports and its
 *    water-quality measurements; a site whose gateways are all offline and
 *    whose last measurement is older than STALE_AFTER_MS is stale.
 *  - key reading: the lowest dissolved oxygen among the site's units, each
 *    unit at its latest measurement of the last day, against the tenant's
 *    configured dissolved-oxygen limits (parameter config `dissolved_oxygen`:
 *    criticalMin, warningMin) — the evaluator farm-service flags critical
 *    measurements with. Measurements are the store both manual entries and
 *    sensor-fed readings land in, and each carries its unit and site; a
 *    channel's latest value carries neither the limit nor the unit.
 *  - temperature: the units' effective water temperature (the one feeding
 *    runs on), the newest reading and the hottest unit.
 *  - feed today: the site's day plans of its local day — planned kg against
 *    the kg fed (meals plus unplanned feeding).
 *  - tanks: only the count entered on the site's systems exists; it is shown
 *    as such (the cell names its source).
 *
 * WHAT: buildProductionRow and its parts, pure over the fetched records.
 */
import type { AlarmPriorityTally } from '@aquaculture/shared-ui';

import type { Cell } from './cell';

export const STALE_AFTER_MS = 30 * 60 * 1000;
export const DISSOLVED_OXYGEN_CODE = 'dissolved_oxygen';

export interface GatewayRecord {
  readonly isOnline: boolean;
  readonly lastSeenAt: string | null;
}

export interface MeasurementRecord {
  readonly tankId: string | null;
  readonly equipmentId: string | null;
  readonly dissolvedOxygen: number | null;
  readonly measuredAt: string;
}

export interface OxygenLimit {
  readonly criticalMin: number | null;
  readonly warningMin: number | null;
}

export interface DayPlanRecord {
  readonly unitId: string;
  readonly unitCode: string;
  readonly status: string;
  readonly plannedTotalKg: number;
  readonly unplannedActualKg: number;
  readonly meals: readonly { readonly actualKg: number }[] | null;
}

export interface UnitTemperatureRecord {
  readonly unitId: string;
  readonly celsius: number | null;
  readonly measuredAt: string | null;
}

export type DataFreshness =
  | { readonly state: 'good'; readonly at: Date }
  | { readonly state: 'stale'; readonly at: Date }
  | { readonly state: 'none' };

export type ReadingLevel = 'critical' | 'warning' | 'normal';

export interface OxygenReading {
  readonly value: number;
  /** The unit's code from today's plans, or null for a unit without one. */
  readonly unitCode: string | null;
  /** The configured limit the value is judged against, null when none is set. */
  readonly limit: number | null;
  readonly level: ReadingLevel;
}

export interface TemperatureReading {
  readonly latest: number;
  readonly hottest: { readonly unitCode: string; readonly celsius: number } | null;
}

export interface FeedProgress {
  readonly plannedKg: number;
  readonly actualKg: number;
  /** actual / planned, 0 for a day planned at 0 kg. */
  readonly ratio: number;
}

export interface ProductionSiteRow {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly tankCount: Cell<number | null>;
  readonly data: Cell<DataFreshness>;
  readonly alarms: Cell<AlarmPriorityTally>;
  readonly oxygen: Cell<OxygenReading | null>;
  readonly temperature: Cell<TemperatureReading | null>;
  readonly feed: Cell<FeedProgress | null>;
}

function latestTime(values: readonly (string | null)[]): Date | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
  }
  return latest === null ? null : new Date(latest);
}

export function dataFreshness(
  gateways: readonly GatewayRecord[],
  measurements: readonly MeasurementRecord[],
  now: Date,
): DataFreshness {
  const at = latestTime([
    ...gateways.map((gateway) => gateway.lastSeenAt),
    ...measurements.map((measurement) => measurement.measuredAt),
  ]);
  if (at === null) return { state: 'none' };
  const live = gateways.some((gateway) => gateway.isOnline);
  return live || now.getTime() - at.getTime() <= STALE_AFTER_MS
    ? { state: 'good', at }
    : { state: 'stale', at };
}

/** The tenant's dissolved-oxygen limits, or null when no active config names them. */
export function oxygenLimitOf(
  configs: readonly {
    readonly code: string;
    readonly criticalMin: number | null;
    readonly warningMin: number | null;
  }[],
): OxygenLimit | null {
  const config = configs.find((candidate) => candidate.code === DISSOLVED_OXYGEN_CODE);
  return config === undefined
    ? null
    : { criticalMin: config.criticalMin, warningMin: config.warningMin };
}

export function oxygenLevel(value: number, limit: OxygenLimit | null): ReadingLevel {
  if (limit?.criticalMin != null && value < limit.criticalMin) return 'critical';
  if (limit?.warningMin != null && value < limit.warningMin) return 'warning';
  return 'normal';
}

/** The lowest of the units' latest dissolved-oxygen values (measurements newest first). */
export function lowestOxygen(
  measurements: readonly MeasurementRecord[],
  unitCodes: ReadonlyMap<string, string>,
  limit: OxygenLimit | null,
): OxygenReading | null {
  const latestByUnit = new Map<string, number>();
  for (const measurement of measurements) {
    const unitId = measurement.tankId ?? measurement.equipmentId;
    if (unitId === null || measurement.dissolvedOxygen === null || latestByUnit.has(unitId)) {
      continue;
    }
    latestByUnit.set(unitId, measurement.dissolvedOxygen);
  }
  let lowest: { unitId: string; value: number } | null = null;
  for (const [unitId, value] of latestByUnit) {
    if (lowest === null || value < lowest.value) lowest = { unitId, value };
  }
  if (lowest === null) return null;
  const level = oxygenLevel(lowest.value, limit);
  return {
    value: lowest.value,
    unitCode: unitCodes.get(lowest.unitId) ?? null,
    limit: limit?.warningMin ?? limit?.criticalMin ?? null,
    level,
  };
}

export function temperatureOf(
  temperatures: readonly UnitTemperatureRecord[],
  unitCodes: ReadonlyMap<string, string>,
): TemperatureReading | null {
  const read = temperatures.filter(
    (entry): entry is UnitTemperatureRecord & { celsius: number } => entry.celsius !== null,
  );
  if (read.length === 0) return null;
  const newest = read.reduce((best, entry) =>
    Date.parse(entry.measuredAt ?? '') > Date.parse(best.measuredAt ?? '') ? entry : best,
  );
  const hottest = read.reduce((best, entry) => (entry.celsius > best.celsius ? entry : best));
  const hottestCode = unitCodes.get(hottest.unitId);
  return {
    latest: newest.celsius,
    hottest:
      read.length > 1 && hottestCode !== undefined
        ? { unitCode: hottestCode, celsius: hottest.celsius }
        : null,
  };
}

/** Planned against fed kg of the day; a cancelled plan feeds nothing and counts nowhere. */
export function feedProgress(plans: readonly DayPlanRecord[]): FeedProgress | null {
  const counted = plans.filter((plan) => plan.status !== 'cancelled');
  if (counted.length === 0) return null;
  let plannedKg = 0;
  let actualKg = 0;
  for (const plan of counted) {
    plannedKg += plan.plannedTotalKg;
    actualKg +=
      plan.unplannedActualKg + (plan.meals ?? []).reduce((sum, meal) => sum + meal.actualKg, 0);
  }
  return { plannedKg, actualKg, ratio: plannedKg > 0 ? actualKg / plannedKg : 0 };
}

/** The tank count entered on the site's systems, or null when no system declares one. */
export function tankCountOf(
  systems: readonly { readonly tankCount: number | null }[],
): number | null {
  const declared = systems.filter(
    (system): system is { tankCount: number } => system.tankCount !== null,
  );
  return declared.length === 0 ? null : declared.reduce((sum, system) => sum + system.tankCount, 0);
}

export function unitCodesOf(plans: readonly DayPlanRecord[]): ReadonlyMap<string, string> {
  return new Map(plans.map((plan) => [plan.unitId, plan.unitCode]));
}
