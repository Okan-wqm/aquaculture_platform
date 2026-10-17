/**
 * Production dashboard: one fish site's row of the Site status table.
 *
 * WHY these sources (each a real record, none estimated):
 *  - key reading: the lowest dissolved oxygen among the units fed today (the
 *    units of the site's day plans), each read by farm-service's one reading
 *    resolver (resolvedUnitParameterValues: a live channel bound to the unit
 *    first, else the latest sample a person took there, in the parameter's
 *    unit, skipped when older than OXYGEN_MAX_AGE_SECONDS), against the
 *    tenant's dissolved-oxygen parameter (`dissolved_oxygen`: criticalMin,
 *    warningMin, unit). The cell says where the value came from (live or
 *    manual) and how old it is. A unit farm no longer has (retired since its
 *    plan) is answered as not found and counts nowhere; the units are asked
 *    in batches farm's many-unit reads take (unitBatches). Water-quality
 *    measurements are not read: the app writes only manual entries there, so
 *    they never held a live value.
 *  - data freshness: the newest of the site's gateways' reports and those
 *    oxygen readings; a site whose gateways are all offline and whose newest
 *    reading is older than STALE_AFTER_MS is stale, and its values are greyed.
 *  - temperature: the same units' effective water temperature (the one
 *    feeding runs on), the newest reading and the hottest unit.
 *  - feed today: the site's day plans of its local day — planned kg against
 *    the kg fed (meals plus unplanned feeding), and the kg the meals scheduled
 *    so far planned (the marker); behind that by more than
 *    FEED_BEHIND_TOLERANCE of the day, the bar turns amber.
 *  - tanks: only the count entered on the site's systems exists; it is shown
 *    as such (the cell names its source).
 *
 * WHAT: buildProductionRow's parts, pure over the fetched records, whose
 * shapes are the supergraph's generated types.
 */
import { MAX_UNITS_PER_READ } from '@aquaculture/shared-contracts';
import type { AlarmPriorityTally } from '@aquaculture/shared-ui';
import type {
  EdgeDevice,
  EffectiveUnitTemperature,
  FeedingDayPlan,
  FeedingDayPlanStatus,
  FeedingMeal,
  FeedingMealStatus,
  ParameterReading,
  SiteType,
  SystemResponse,
  UnitParameterReading,
  WaterQualityParameterConfig,
} from '@platform/shared-ui/generated/graphql-types';

import type { Cell } from './cell';

export const STALE_AFTER_MS = 30 * 60 * 1000;
export const DISSOLVED_OXYGEN_CODE = 'dissolved_oxygen';
/** A dissolved-oxygen value older than a day is not shown as the unit's. */
export const OXYGEN_MAX_AGE_SECONDS = 24 * 60 * 60;
/** How far the fed share may trail the share planned by now before the bar turns amber (design D6). */
export const FEED_BEHIND_TOLERANCE = 0.1;

export type GatewayRecord = Pick<EdgeDevice, 'id' | 'isOnline' | 'lastSeenAt'>;

export type OxygenParameterRecord = Pick<
  WaterQualityParameterConfig,
  'id' | 'code' | 'unit' | 'criticalMin' | 'warningMin'
>;

export type MealRecord = Pick<FeedingMeal, 'actualKg' | 'plannedKg' | 'scheduledAt' | 'status'>;

export type DayPlanRecord = Pick<
  FeedingDayPlan,
  'id' | 'unitId' | 'unitCode' | 'status' | 'plannedTotalKg' | 'unplannedActualKg'
> & { readonly meals?: readonly MealRecord[] | null };

export type UnitTemperatureRecord = Pick<
  EffectiveUnitTemperature,
  'unitId' | 'celsius' | 'measuredAt'
>;

/** One asked unit's answer: its reading, or null when farm has no active unit with its id. */
export type UnitReadingRecord = Pick<UnitParameterReading, 'unitId'> & {
  readonly reading?: Pick<
    ParameterReading,
    'value' | 'unit' | 'sourceKind' | 'observedAt' | 'unresolved'
  > | null;
};

export type SystemRecord = Pick<SystemResponse, 'id' | 'tankCount'>;

/** The tenant's dissolved-oxygen parameter: what the units are read as, and its limits. */
export interface OxygenParameter {
  readonly id: string;
  readonly unit: string;
  readonly criticalMin: number | null;
  readonly warningMin: number | null;
}

export type DataFreshness =
  | { readonly state: 'good'; readonly at: Date }
  | { readonly state: 'stale'; readonly at: Date }
  | { readonly state: 'none' };

export type ReadingLevel = 'critical' | 'warning' | 'normal';

/** Where a reading came from: a sensor channel, or a sample a person took. */
export type ReadingSource = 'live' | 'manual';

export interface OxygenReading {
  readonly value: number;
  /** The parameter's unit, the one the resolver answered in. */
  readonly unit: string;
  /** The unit's code from today's plans. */
  readonly unitCode: string;
  /** The configured limit the value is judged against, null when none is set. */
  readonly limit: number | null;
  readonly level: ReadingLevel;
  readonly source: ReadingSource;
  readonly observedAt: Date;
}

/**
 * The key-reading cell: the lowest reading, or why there is none — no
 * dissolved-oxygen parameter configured, no unit fed today, or no unit with a
 * value within the window.
 */
export type OxygenState =
  | { readonly kind: 'reading'; readonly reading: OxygenReading }
  | { readonly kind: 'noParameter' }
  | { readonly kind: 'noUnits' }
  | { readonly kind: 'noReading' };

export interface TemperatureReading {
  readonly latest: number;
  readonly hottest: { readonly unitCode: string; readonly celsius: number } | null;
}

export interface FeedProgress {
  readonly plannedKg: number;
  readonly actualKg: number;
  /** actual / planned, 0 for a day planned at 0 kg. */
  readonly ratio: number;
  /** The share of the day's plan the meals scheduled so far planned; null when no plan names its meals. */
  readonly plannedByNowRatio: number | null;
  /** Fed share below the planned-by-now share by more than FEED_BEHIND_TOLERANCE. */
  readonly behind: boolean;
}

export interface ProductionSiteRow {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly type: SiteType;
  readonly tankCount: Cell<number | null>;
  readonly data: Cell<DataFreshness>;
  readonly alarms: Cell<AlarmPriorityTally>;
  readonly oxygen: Cell<OxygenState>;
  readonly temperature: Cell<TemperatureReading | null>;
  readonly feed: Cell<FeedProgress | null>;
}

function latestTime(values: readonly (string | null | undefined)[]): Date | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
  }
  return latest === null ? null : new Date(latest);
}

/** The site's freshness: its gateways' reports and the times of the readings the row shows. */
export function dataFreshness(
  gateways: readonly GatewayRecord[],
  readingTimes: readonly (string | null | undefined)[],
  now: Date,
): DataFreshness {
  const at = latestTime([...gateways.map((gateway) => gateway.lastSeenAt), ...readingTimes]);
  if (at === null) return { state: 'none' };
  const live = gateways.some((gateway) => gateway.isOnline);
  return live || now.getTime() - at.getTime() <= STALE_AFTER_MS
    ? { state: 'good', at }
    : { state: 'stale', at };
}

/** The tenant's active dissolved-oxygen parameter, or null when none is configured. */
export function oxygenParameterOf(
  configs: readonly OxygenParameterRecord[],
): OxygenParameter | null {
  const config = configs.find((candidate) => candidate.code === DISSOLVED_OXYGEN_CODE);
  return config === undefined
    ? null
    : {
        id: config.id,
        unit: config.unit,
        criticalMin: config.criticalMin ?? null,
        warningMin: config.warningMin ?? null,
      };
}

export function oxygenLevel(
  value: number,
  limit: Pick<OxygenParameter, 'criticalMin' | 'warningMin'>,
): ReadingLevel {
  if (limit.criticalMin !== null && value < limit.criticalMin) return 'critical';
  if (limit.warningMin !== null && value < limit.warningMin) return 'warning';
  return 'normal';
}

/**
 * The lowest value among the units' resolved readings; a unit without a value,
 * or one farm answered as not found, counts nowhere.
 */
export function lowestOxygen(
  entries: readonly UnitReadingRecord[],
  unitCodes: ReadonlyMap<string, string>,
  parameter: OxygenParameter,
): OxygenState {
  let lowest: OxygenReading | null = null;
  for (const { unitId, reading } of entries) {
    if (reading === null || reading === undefined) continue;
    const { value, observedAt, sourceKind } = reading;
    if (value === null || value === undefined) continue;
    if (observedAt === null || observedAt === undefined) continue;
    if (sourceKind === null || sourceKind === undefined) continue;
    // Only the units asked for (today's plans) are answered; anything else counts nowhere.
    const unitCode = unitCodes.get(unitId);
    if (unitCode === undefined) continue;
    if (lowest !== null && value >= lowest.value) continue;
    lowest = {
      value,
      unit: reading.unit,
      unitCode,
      limit: parameter.warningMin ?? parameter.criticalMin,
      level: oxygenLevel(value, parameter),
      source: sourceKind === 'MANUAL' ? 'manual' : 'live',
      observedAt: new Date(observedAt),
    };
  }
  return lowest === null ? { kind: 'noReading' } : { kind: 'reading', reading: lowest };
}

export function temperatureOf(
  temperatures: readonly UnitTemperatureRecord[],
  unitCodes: ReadonlyMap<string, string>,
): TemperatureReading | null {
  const read: { unitId: string; celsius: number; measuredAt: number }[] = [];
  for (const entry of temperatures) {
    if (entry.celsius === null || entry.celsius === undefined) continue;
    const measuredAt = Date.parse(entry.measuredAt ?? '');
    read.push({
      unitId: entry.unitId,
      celsius: entry.celsius,
      measuredAt: Number.isFinite(measuredAt) ? measuredAt : 0,
    });
  }
  const [first] = read;
  if (first === undefined) return null;
  const newest = read.reduce((best, entry) => (entry.measuredAt > best.measuredAt ? entry : best));
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

/** A day plan or meal that does not feed: cancelled, or skipped (a fasting window, an operator's call). */
const NOT_FEEDING_PLAN: ReadonlySet<FeedingDayPlanStatus> = new Set(['CANCELLED', 'SKIPPED']);
const NOT_FEEDING_MEAL: ReadonlySet<FeedingMealStatus> = new Set(['CANCELLED', 'SKIPPED']);

/**
 * Planned against fed kg of the day, and the share the meals scheduled by
 * `now` planned. A cancelled or skipped plan feeds nothing and counts nowhere.
 */
export function feedProgress(plans: readonly DayPlanRecord[], now: Date): FeedProgress | null {
  const counted = plans.filter((plan) => !NOT_FEEDING_PLAN.has(plan.status));
  if (counted.length === 0) return null;
  let plannedKg = 0;
  let actualKg = 0;
  let plannedByNowKg = 0;
  let scheduled = false;
  for (const plan of counted) {
    plannedKg += plan.plannedTotalKg;
    actualKg += plan.unplannedActualKg;
    for (const meal of plan.meals ?? []) {
      actualKg += meal.actualKg;
      scheduled = true;
      if (!NOT_FEEDING_MEAL.has(meal.status) && Date.parse(meal.scheduledAt) <= now.getTime()) {
        plannedByNowKg += meal.plannedKg;
      }
    }
  }
  const ratio = plannedKg > 0 ? actualKg / plannedKg : 0;
  const plannedByNowRatio = scheduled && plannedKg > 0 ? plannedByNowKg / plannedKg : null;
  return {
    plannedKg,
    actualKg,
    ratio,
    plannedByNowRatio,
    behind: plannedByNowRatio !== null && ratio < plannedByNowRatio - FEED_BEHIND_TOLERANCE,
  };
}

/** The tank count entered on the site's systems, or null when no system declares one. */
export function tankCountOf(systems: readonly SystemRecord[]): number | null {
  let total: number | null = null;
  for (const system of systems) {
    if (system.tankCount === null || system.tankCount === undefined) continue;
    total = (total ?? 0) + system.tankCount;
  }
  return total;
}

export function unitCodesOf(plans: readonly DayPlanRecord[]): ReadonlyMap<string, string> {
  return new Map(plans.map((plan) => [plan.unitId, plan.unitCode]));
}

/** The units today's plans name, sorted (a stable query key). */
export function plannedUnitIds(plans: readonly DayPlanRecord[]): string[] {
  return [...new Set(plans.map((plan) => plan.unitId))].sort();
}

/**
 * A site's units in the batches one many-unit read takes, in order: farm
 * refuses more than MAX_UNITS_PER_READ units in one request, and a site's
 * day plans may name more.
 */
export function unitBatches(unitIds: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < unitIds.length; start += MAX_UNITS_PER_READ) {
    batches.push(unitIds.slice(start, start + MAX_UNITS_PER_READ));
  }
  return batches;
}

/** When each answered unit's reading was observed (a not-found unit has none). */
export function observedTimesOf(
  entries: readonly UnitReadingRecord[],
): (string | null | undefined)[] {
  return entries.flatMap(({ reading }) =>
    reading === null || reading === undefined ? [] : [reading.observedAt],
  );
}
