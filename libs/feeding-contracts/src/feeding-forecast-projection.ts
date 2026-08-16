export const FEEDING_FORECAST_PROJECTION_V1 = Object.freeze({
  schemaVersion: 'feeding-forecast-projection/v1',
  tenantScopeKey: 'tenant',
  maxHorizonDays: 120,
  staleAfterMilliseconds: 26 * 60 * 60 * 1000,
  retentionDays: 30,
  poolScopes: Object.freeze(['TENANT', 'SITE'] as const),
  alertTypes: Object.freeze([
    'STOCKOUT_FORECAST',
    'TRANSITION_COVERAGE_GAP',
    'REORDER_NOW',
    'SITE_TRANSFER_NEEDED',
  ] as const),
  persistedFields: Object.freeze([
    'siteScopeKey',
    'poolScope',
    'horizonDays',
    'computedAt',
    'perFeed',
    'perUnit',
    'alerts',
    'mortalityAssumption',
  ] as const),
  graphqlFields: Object.freeze([
    'siteScopeKey',
    'poolScope',
    'stale',
    'horizonDays',
    'computedAt',
    'perFeed',
    'perUnit',
    'alerts',
    'mortalityAssumption',
  ] as const),
} as const);

export type FeedingForecastPoolScope =
  (typeof FEEDING_FORECAST_PROJECTION_V1.poolScopes)[number];
export type FeedingForecastAlertType =
  (typeof FEEDING_FORECAST_PROJECTION_V1.alertTypes)[number];

export const FEEDING_FORECAST_MORTALITY_PROVENANCE_V1 = Object.freeze({
  schemaVersion: 'feeding-forecast-mortality-provenance/v1',
  coverage: Object.freeze(['NONE', 'PARTIAL', 'COMPLETE'] as const),
  sources: Object.freeze(['species_survival_rate', 'none'] as const),
});

export type FeedingForecastMortalityCoverageV1 =
  (typeof FEEDING_FORECAST_MORTALITY_PROVENANCE_V1.coverage)[number];
export type FeedingForecastMortalitySourceV1 =
  (typeof FEEDING_FORECAST_MORTALITY_PROVENANCE_V1.sources)[number];

export interface FeedingForecastMortalityUnitProvenanceV1 {
  readonly unitId: string;
  readonly source: FeedingForecastMortalitySourceV1;
  readonly dailySurvivalRate: number;
}

export interface FeedingForecastMortalityProvenanceV1 {
  readonly schemaVersion: typeof FEEDING_FORECAST_MORTALITY_PROVENANCE_V1.schemaVersion;
  readonly coverage: FeedingForecastMortalityCoverageV1;
  readonly unitCount: number;
  readonly speciesRateUnitCount: number;
  readonly conservativeDefaultUnitCount: number;
  readonly units: readonly FeedingForecastMortalityUnitProvenanceV1[];
}

export interface FeedingForecastPoolIdentityV1 {
  readonly siteScopeKey: string;
  readonly poolScope: FeedingForecastPoolScope;
}

export interface FeedingForecastAlertV1 {
  readonly type: FeedingForecastAlertType;
  readonly feedId: string;
  readonly unitId?: string;
  /** Type-specific magnitude, not a horizon coordinate. */
  readonly days: number;
  /** Zero-based horizon coordinate used by every reader. */
  readonly atDay: number;
}

export interface FeedingForecastBandCoordinateV1 {
  readonly atDay: number;
  readonly feedId: string;
}

export interface FeedingForecastBandTransitionV1 {
  readonly fromFeedId: string;
  readonly toFeedId: string;
  readonly atDay: number;
}

export interface FeedingForecastBandPathV1 {
  readonly currentFeedId: string | null;
  readonly terminalFeedId: string | null;
  readonly transitions: readonly FeedingForecastBandTransitionV1[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertBoundedIdentity(value: string, field: string): void {
  if (value.length < 1 || value.length > 100 || value.trim() !== value) {
    throw new Error(`${field} must be one bounded canonical identity`);
  }
}

/** Compile exact, unit-addressable mortality provenance for one pool scope. */
export function compileFeedingForecastMortalityProvenanceV1(
  entries: readonly FeedingForecastMortalityUnitProvenanceV1[],
): FeedingForecastMortalityProvenanceV1 {
  const byUnit = new Map<string, FeedingForecastMortalityUnitProvenanceV1>();
  for (const entry of entries) {
    assertBoundedIdentity(entry.unitId, 'mortalityProvenance.unitId');
    if (!FEEDING_FORECAST_MORTALITY_PROVENANCE_V1.sources.includes(entry.source)) {
      throw new Error(`Unsupported mortality provenance source ${entry.source}`);
    }
    if (
      !Number.isFinite(entry.dailySurvivalRate) ||
      entry.dailySurvivalRate <= 0 ||
      entry.dailySurvivalRate > 1 ||
      (entry.source === 'none' && entry.dailySurvivalRate !== 1)
    ) {
      throw new Error(`Invalid mortality survival rate for unit ${entry.unitId}`);
    }
    if (byUnit.has(entry.unitId)) {
      throw new Error(`Duplicate mortality provenance unit ${entry.unitId}`);
    }
    byUnit.set(
      entry.unitId,
      Object.freeze({
        unitId: entry.unitId,
        source: entry.source,
        dailySurvivalRate: entry.dailySurvivalRate,
      }),
    );
  }

  const units = Object.freeze([...byUnit.values()].sort((left, right) =>
    left.unitId.localeCompare(right.unitId),
  ));
  const speciesRateUnitCount = units.filter(
    (unit) => unit.source === 'species_survival_rate',
  ).length;
  const conservativeDefaultUnitCount = units.length - speciesRateUnitCount;
  const coverage: FeedingForecastMortalityCoverageV1 =
    speciesRateUnitCount === 0
      ? 'NONE'
      : conservativeDefaultUnitCount === 0
        ? 'COMPLETE'
        : 'PARTIAL';
  return Object.freeze({
    schemaVersion: FEEDING_FORECAST_MORTALITY_PROVENANCE_V1.schemaVersion,
    coverage,
    unitCount: units.length,
    speciesRateUnitCount,
    conservativeDefaultUnitCount,
    units,
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/**
 * Runtime decoder used at persistence/read boundaries. Legacy global booleans
 * are rejected because they cannot prove which unit used which assumption.
 */
export function assertFeedingForecastMortalityProvenanceV1(
  value: unknown,
  expectedUnitIds?: readonly string[],
): FeedingForecastMortalityProvenanceV1 {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record['units'])) {
    throw new Error('Forecast mortality provenance is not unit-addressable');
  }
  const entries = record['units'].map((candidate) => {
    const unit = objectRecord(candidate);
    if (
      !unit ||
      typeof unit['unitId'] !== 'string' ||
      (unit['source'] !== 'species_survival_rate' && unit['source'] !== 'none') ||
      typeof unit['dailySurvivalRate'] !== 'number'
    ) {
      throw new Error('Forecast mortality provenance contains an invalid unit entry');
    }
    return {
      unitId: unit['unitId'],
      source: unit['source'],
      dailySurvivalRate: unit['dailySurvivalRate'],
    } satisfies FeedingForecastMortalityUnitProvenanceV1;
  });
  const compiled = compileFeedingForecastMortalityProvenanceV1(entries);
  if (
    record['schemaVersion'] !== compiled.schemaVersion ||
    record['coverage'] !== compiled.coverage ||
    record['unitCount'] !== compiled.unitCount ||
    record['speciesRateUnitCount'] !== compiled.speciesRateUnitCount ||
    record['conservativeDefaultUnitCount'] !== compiled.conservativeDefaultUnitCount
  ) {
    throw new Error('Forecast mortality provenance summary differs from its unit evidence');
  }
  if (expectedUnitIds !== undefined) {
    const expected = [...new Set(expectedUnitIds)].sort();
    const observed = compiled.units.map((unit) => unit.unitId);
    if (
      expected.length !== expectedUnitIds.length ||
      expected.length !== observed.length ||
      expected.some((unitId, index) => unitId !== observed[index])
    ) {
      throw new Error('Forecast mortality provenance does not cover the exact unit set');
    }
  }
  return compiled;
}

/** Sole compiler for persisted forecast pool identities. */
export function compileFeedingForecastPoolIdentityV1(
  siteScopeKey: string,
  poolScope: FeedingForecastPoolScope,
): FeedingForecastPoolIdentityV1 {
  assertBoundedIdentity(siteScopeKey, 'siteScopeKey');
  const isTenantKey = siteScopeKey === FEEDING_FORECAST_PROJECTION_V1.tenantScopeKey;
  if (
    (poolScope === 'TENANT' && !isTenantKey) ||
    (poolScope === 'SITE' && (isTenantKey || !UUID_PATTERN.test(siteScopeKey)))
  ) {
    throw new Error(`Forecast scope ${siteScopeKey}/${poolScope} has conflicting pool semantics`);
  }
  return Object.freeze({ siteScopeKey, poolScope });
}

/** Every unit contributes once to TENANT and optionally once to its SITE projection. */
export function feedingForecastPoolMembershipV1(
  siteId: string,
  hasLocalStorage: boolean,
): readonly FeedingForecastPoolIdentityV1[] {
  const tenant = compileFeedingForecastPoolIdentityV1(
    FEEDING_FORECAST_PROJECTION_V1.tenantScopeKey,
    'TENANT',
  );
  if (!hasLocalStorage) return Object.freeze([tenant]);
  return Object.freeze([tenant, compileFeedingForecastPoolIdentityV1(siteId, 'SITE')]);
}

/** Exact-set reconciliation decision used by the sole persistence adapter. */
export function feedingForecastScopeKeysToPruneV1(
  persisted: readonly FeedingForecastPoolIdentityV1[],
  desired: readonly FeedingForecastPoolIdentityV1[],
): readonly string[] {
  const desiredKeys = new Set<string>();
  for (const identity of desired) {
    const compiled = compileFeedingForecastPoolIdentityV1(
      identity.siteScopeKey,
      identity.poolScope,
    );
    if (desiredKeys.has(compiled.siteScopeKey)) {
      throw new Error(`Duplicate desired forecast scope ${compiled.siteScopeKey}`);
    }
    desiredKeys.add(compiled.siteScopeKey);
  }
  const removable = new Set<string>();
  for (const identity of persisted) {
    const compiled = compileFeedingForecastPoolIdentityV1(
      identity.siteScopeKey,
      identity.poolScope,
    );
    if (!desiredKeys.has(compiled.siteScopeKey)) removable.add(compiled.siteScopeKey);
  }
  return Object.freeze([...removable].sort());
}

/** Sole day-zero/terminal/transition resolver for one simulated unit. */
export function compileFeedingForecastBandPathV1(
  coordinates: readonly FeedingForecastBandCoordinateV1[],
): FeedingForecastBandPathV1 {
  let previousDay = -1;
  let previousFeed: string | undefined;
  const transitions: FeedingForecastBandTransitionV1[] = [];
  for (const coordinate of coordinates) {
    assertBoundedIdentity(coordinate.feedId, 'feedId');
    if (!Number.isSafeInteger(coordinate.atDay) || coordinate.atDay < 0) {
      throw new Error('Forecast band coordinate requires a non-negative safe day');
    }
    if (coordinate.atDay <= previousDay) {
      throw new Error('Forecast band coordinates must be strictly day-ordered');
    }
    if (previousFeed && coordinate.feedId !== previousFeed) {
      transitions.push({
        fromFeedId: previousFeed,
        toFeedId: coordinate.feedId,
        atDay: coordinate.atDay,
      });
    }
    previousDay = coordinate.atDay;
    previousFeed = coordinate.feedId;
  }
  return Object.freeze({
    currentFeedId: coordinates[0]?.feedId ?? null,
    terminalFeedId: previousFeed ?? null,
    transitions: Object.freeze(transitions),
  });
}

export function compileFeedingForecastAlertV1(
  alert: FeedingForecastAlertV1,
): FeedingForecastAlertV1 {
  if (!FEEDING_FORECAST_PROJECTION_V1.alertTypes.includes(alert.type)) {
    throw new Error(`Unsupported forecast alert ${alert.type}`);
  }
  assertBoundedIdentity(alert.feedId, 'feedId');
  if (alert.unitId !== undefined) assertBoundedIdentity(alert.unitId, 'unitId');
  if (
    !Number.isSafeInteger(alert.days) ||
    alert.days < 0 ||
    !Number.isSafeInteger(alert.atDay) ||
    alert.atDay < 0
  ) {
    throw new Error('Forecast alert days and atDay must be non-negative safe integers');
  }
  return Object.freeze({ ...alert });
}

export function feedingForecastAlertWithinHorizonV1(
  alert: FeedingForecastAlertV1,
  horizonDays: number,
): boolean {
  return Number.isSafeInteger(horizonDays) && horizonDays > 0 && alert.atDay < horizonDays;
}

export function feedingForecastIsStaleV1(computedAt: Date, observedAt: Date): boolean {
  const computedMilliseconds = computedAt.getTime();
  const observedMilliseconds = observedAt.getTime();
  if (!Number.isFinite(computedMilliseconds) || !Number.isFinite(observedMilliseconds)) {
    throw new Error('Forecast freshness requires finite explicit instants');
  }
  return (
    observedMilliseconds - computedMilliseconds >
    FEEDING_FORECAST_PROJECTION_V1.staleAfterMilliseconds
  );
}
