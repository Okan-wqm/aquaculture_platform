import {
  assertSafeSchemaName,
  getTenantSchemaName,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

import { MonitoringAreaGeometry } from '../../site/entities/site.entity';
import {
  CANONICAL_SYNC_PROVIDERS,
  CanonicalEnvironmentProvider,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeCoverage,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
  SATELLITE_COVERAGE_LEGACY_METHOD,
  SatelliteCoverageStatus,
  isCanonicalEnvironmentProvider,
} from '../entities/environment-observation.types';
import { WeatherDataType } from '../entities/weather-observation.entity';

interface LeaseDatabaseRow {
  schema_name: string;
  tenant_id: string;
  site_id: string;
  provider: string;
  lease_token: string;
  monitoring_location_revision: number;
  latitude: number;
  longitude: number;
  altitude_m: number | null;
  monitoring_radius_m: number;
  monitoring_area: MonitoringAreaGeometry | null;
  cursor: string | null;
  consecutive_failures: number;
}

interface LockedLeaseRow {
  id: string;
}

export interface EnvironmentSyncLease {
  schema: string;
  tenantId: string;
  siteId: string;
  provider: CanonicalEnvironmentProvider;
  token: string;
  monitoringLocationRevision: number;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  monitoringRadiusM: number;
  monitoringArea: MonitoringAreaGeometry | null;
  cursor: string | null;
  consecutiveFailures: number;
}

export interface CanonicalWeatherInsert {
  tenantId: string;
  siteId: string;
  observedAt: Date;
  dataType: WeatherDataType;
  provider: EnvironmentProvider.MET_LOCATIONFORECAST | EnvironmentProvider.MET_FROST;
  productId: string;
  datasetId: string;
  sourceRunKey: string;
  issuedAt: Date | null;
  semanticClass: EnvironmentSemanticClass;
  qualityStatus: EnvironmentQualityStatus;
  stationId: string | null;
  stationDistanceKm: number | null;
  horizontalResolutionM: number | null;
  monitoringLocationRevision: number;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  windGusts: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  pressureMsl: number | null;
  relativeHumidity: number | null;
  fetchedAt: Date;
}

export interface CanonicalMarineInsert {
  tenantId: string;
  siteId: string;
  observedAt: Date;
  dataType: WeatherDataType;
  provider: EnvironmentProvider.CMEMS;
  productId: string;
  datasetId: string;
  variableSetId: string;
  sourceRunKey: string;
  issuedAt: Date | null;
  semanticClass: EnvironmentSemanticClass.ANALYSIS | EnvironmentSemanticClass.FORECAST;
  qualityStatus: EnvironmentQualityStatus.PROVISIONAL;
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  oceanCurrentVelocity: number | null;
  oceanCurrentDirection: number | null;
  seaSurfaceTemperature: number | null;
  salinity: number | null;
  dissolvedOxygen: number | null;
  modelChlorophyll: number | null;
  requestedDepthM: number | null;
  modelDepthM: number | null;
  horizontalResolutionM: number;
  gridCellDistanceM: number | null;
  coveragePercent: number | null;
  monitoringLocationRevision: number;
  fetchedAt: Date;
}

export interface CanonicalSatelliteSceneInsert {
  tenantId: string;
  siteId: string;
  sceneId: string;
  collection: string;
  provider: EnvironmentProvider.CDSE_SENTINEL_2;
  productId: string;
  datasetId: string;
  acquiredAt: Date;
  cloudCoverPercent: number | null;
  coveragePercent: number | null;
  coverageStatus: SatelliteCoverageStatus;
  coverageMethod: string;
  /** AOI sample points used; status disambiguates exact and unresolved zero. */
  coverageSampleCount: number;
  qualityStatus: EnvironmentQualityStatus;
  monitoringLocationRevision: number;
  fetchedAt: Date;
}

export interface EnvironmentSyncCompletion {
  status: Exclude<
    EnvironmentSyncStatus,
    EnvironmentSyncStatus.PENDING | EnvironmentSyncStatus.RUNNING
  >;
  nextRunAt: Date;
  errorCode: string | null;
  cursor: string | null;
  successfulProviderResponse: boolean;
  coverage: readonly EnvironmentSyncScopeCoverage[];
  weather: readonly CanonicalWeatherInsert[];
  marine: readonly CanonicalMarineInsert[];
  scenes: readonly CanonicalSatelliteSceneInsert[];
}

export interface EnvironmentCoverageSummary {
  expected: number;
  successful: number;
  failed: number;
  noData: number;
  outOfCoverage: number;
}

export interface EnvironmentRetentionResult {
  weatherDeleted: number;
  marineDeleted: number;
  scenesDeleted: number;
  obsoleteStatesDeleted: number;
}

export interface EnvironmentDueBacklog {
  dueCount: number;
  oldestDueAt: Date | null;
}

export class EnvironmentCompletionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentCompletionContractError';
  }
}

const NUMERIC_STORAGE_BOUNDS = Object.freeze({
  weatherScalar: Object.freeze({ minimum: -9_999.99, maximum: 9_999.99 }),
  weatherNonNegative: Object.freeze({ minimum: 0, maximum: 9_999.99 }),
  direction: Object.freeze({ minimum: 0, maximum: 360 }),
  percentage: Object.freeze({ minimum: 0, maximum: 100 }),
  pressure: Object.freeze({ minimum: 0, maximum: 99_999.99 }),
  stationDistanceKm: Object.freeze({ minimum: 0, maximum: 9_999_999.999 }),
  wave: Object.freeze({ minimum: 0, maximum: 999.99 }),
  currentSpeed: Object.freeze({ minimum: 0, maximum: 99.999 }),
  seaTemperature: Object.freeze({ minimum: -999.99, maximum: 999.99 }),
  salinity: Object.freeze({ minimum: 0, maximum: 9_999.9999 }),
  dissolvedOxygen: Object.freeze({ minimum: 0, maximum: 9_999_999.99999 }),
  modelChlorophyll: Object.freeze({ minimum: 0, maximum: 999_999.999999 }),
  depthM: Object.freeze({ minimum: 0, maximum: 9_999_999.999 }),
  horizontalResolutionM: Object.freeze({ minimum: 0.001, maximum: 999_999_999.999 }),
  gridCellDistanceM: Object.freeze({ minimum: 0, maximum: 999_999_999.999 }),
});

function contract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new EnvironmentCompletionContractError(message);
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function boundedString(value: string, maximumLength: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function optionalNumberInRange(
  value: number | null,
  bounds: { minimum: number; maximum: number },
): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= bounds.minimum &&
      value <= bounds.maximum)
  );
}

function assertWeatherContract(row: CanonicalWeatherInsert): void {
  contract(validDate(row.observedAt) && validDate(row.fetchedAt), 'Weather timestamps are invalid');
  contract(
    row.dataType === WeatherDataType.FORECAST || row.dataType === WeatherDataType.HISTORICAL,
    'Weather data type is invalid',
  );
  contract(
    boundedString(row.productId, 160) &&
      boundedString(row.datasetId, 200) &&
      boundedString(row.sourceRunKey, 200),
    'Weather provenance exceeds the persistence contract',
  );
  contract(
    row.qualityStatus === EnvironmentQualityStatus.VALID ||
      row.qualityStatus === EnvironmentQualityStatus.PROVISIONAL,
    'Weather quality status is invalid',
  );
  if (row.provider === EnvironmentProvider.MET_LOCATIONFORECAST) {
    contract(
      row.issuedAt !== null &&
        validDate(row.issuedAt) &&
        row.semanticClass === EnvironmentSemanticClass.FORECAST &&
        row.stationId === null &&
        row.stationDistanceKm === null,
      'Locationforecast provenance is invalid',
    );
  } else {
    contract(
      row.provider === EnvironmentProvider.MET_FROST &&
        row.issuedAt === null &&
        row.semanticClass === EnvironmentSemanticClass.OBSERVATION &&
        row.stationId !== null &&
        boundedString(row.stationId, 100) &&
        optionalNumberInRange(row.stationDistanceKm, NUMERIC_STORAGE_BOUNDS.stationDistanceKm),
      'Frost provenance is invalid',
    );
  }
  contract(
    optionalNumberInRange(row.horizontalResolutionM, NUMERIC_STORAGE_BOUNDS.horizontalResolutionM),
    'Weather resolution exceeds the persistence contract',
  );

  const measurements = [
    row.temperature,
    row.windSpeed,
    row.windDirection,
    row.windGusts,
    row.precipitation,
    row.cloudCover,
    row.pressureMsl,
    row.relativeHumidity,
  ];
  contract(
    measurements.some((value) => value !== null),
    'Weather row has no measurement',
  );
  contract(
    optionalNumberInRange(row.temperature, NUMERIC_STORAGE_BOUNDS.weatherScalar) &&
      optionalNumberInRange(row.windSpeed, NUMERIC_STORAGE_BOUNDS.weatherNonNegative) &&
      optionalNumberInRange(row.windDirection, NUMERIC_STORAGE_BOUNDS.direction) &&
      optionalNumberInRange(row.windGusts, NUMERIC_STORAGE_BOUNDS.weatherNonNegative) &&
      optionalNumberInRange(row.precipitation, NUMERIC_STORAGE_BOUNDS.weatherNonNegative) &&
      optionalNumberInRange(row.cloudCover, NUMERIC_STORAGE_BOUNDS.percentage) &&
      optionalNumberInRange(row.pressureMsl, NUMERIC_STORAGE_BOUNDS.pressure) &&
      optionalNumberInRange(row.relativeHumidity, NUMERIC_STORAGE_BOUNDS.percentage),
    'Weather measurement exceeds the persistence contract',
  );
}

function assertMarineContract(row: CanonicalMarineInsert): void {
  contract(validDate(row.observedAt) && validDate(row.fetchedAt), 'Marine timestamps are invalid');
  contract(
    row.dataType === WeatherDataType.FORECAST || row.dataType === WeatherDataType.HISTORICAL,
    'Marine data type is invalid',
  );
  contract(
    row.provider === EnvironmentProvider.CMEMS &&
      boundedString(row.productId, 160) &&
      boundedString(row.datasetId, 200) &&
      boundedString(row.variableSetId, 100) &&
      boundedString(row.sourceRunKey, 200),
    'Marine provenance exceeds the persistence contract',
  );
  contract(row.issuedAt === null || validDate(row.issuedAt), 'Marine issue timestamp is invalid');
  contract(
    (row.semanticClass === EnvironmentSemanticClass.ANALYSIS ||
      row.semanticClass === EnvironmentSemanticClass.FORECAST) &&
      row.qualityStatus === EnvironmentQualityStatus.PROVISIONAL,
    'Marine semantic or quality status is invalid',
  );

  const measurements = [
    row.waveHeight,
    row.waveDirection,
    row.wavePeriod,
    row.oceanCurrentVelocity,
    row.oceanCurrentDirection,
    row.seaSurfaceTemperature,
    row.salinity,
    row.dissolvedOxygen,
    row.modelChlorophyll,
  ];
  contract(
    measurements.some((value) => value !== null),
    'Marine row has no measurement',
  );
  contract(
    optionalNumberInRange(row.waveHeight, NUMERIC_STORAGE_BOUNDS.wave) &&
      optionalNumberInRange(row.waveDirection, NUMERIC_STORAGE_BOUNDS.direction) &&
      optionalNumberInRange(row.wavePeriod, NUMERIC_STORAGE_BOUNDS.wave) &&
      optionalNumberInRange(row.oceanCurrentVelocity, NUMERIC_STORAGE_BOUNDS.currentSpeed) &&
      optionalNumberInRange(row.oceanCurrentDirection, NUMERIC_STORAGE_BOUNDS.direction) &&
      optionalNumberInRange(row.seaSurfaceTemperature, NUMERIC_STORAGE_BOUNDS.seaTemperature) &&
      optionalNumberInRange(row.salinity, NUMERIC_STORAGE_BOUNDS.salinity) &&
      optionalNumberInRange(row.dissolvedOxygen, NUMERIC_STORAGE_BOUNDS.dissolvedOxygen) &&
      optionalNumberInRange(row.modelChlorophyll, NUMERIC_STORAGE_BOUNDS.modelChlorophyll) &&
      optionalNumberInRange(row.requestedDepthM, NUMERIC_STORAGE_BOUNDS.depthM) &&
      optionalNumberInRange(row.modelDepthM, NUMERIC_STORAGE_BOUNDS.depthM) &&
      optionalNumberInRange(
        row.horizontalResolutionM,
        NUMERIC_STORAGE_BOUNDS.horizontalResolutionM,
      ) &&
      optionalNumberInRange(row.gridCellDistanceM, NUMERIC_STORAGE_BOUNDS.gridCellDistanceM) &&
      optionalNumberInRange(row.coveragePercent, NUMERIC_STORAGE_BOUNDS.percentage),
    'Marine measurement or dimension exceeds the persistence contract',
  );
}

function assertSceneContract(row: CanonicalSatelliteSceneInsert): void {
  contract(validDate(row.acquiredAt) && validDate(row.fetchedAt), 'Scene timestamps are invalid');
  contract(
    row.provider === EnvironmentProvider.CDSE_SENTINEL_2 &&
      boundedString(row.sceneId, 512) &&
      boundedString(row.collection, 100) &&
      boundedString(row.productId, 512) &&
      boundedString(row.datasetId, 200),
    'Scene provenance exceeds the persistence contract',
  );
  contract(
    [
      EnvironmentQualityStatus.VALID,
      EnvironmentQualityStatus.PROVISIONAL,
      EnvironmentQualityStatus.NO_DATA,
      EnvironmentQualityStatus.CLOUD_OBSCURED,
      EnvironmentQualityStatus.OUT_OF_COVERAGE,
    ].includes(row.qualityStatus),
    'Scene quality status is invalid',
  );
  contract(
    optionalNumberInRange(row.cloudCoverPercent, NUMERIC_STORAGE_BOUNDS.percentage) &&
      optionalNumberInRange(row.coveragePercent, NUMERIC_STORAGE_BOUNDS.percentage),
    'Scene percentage exceeds the persistence contract',
  );
  contract(
    row.coverageStatus !== SatelliteCoverageStatus.UNKNOWN &&
      boundedString(row.coverageMethod, 100) &&
      row.coverageMethod !== SATELLITE_COVERAGE_LEGACY_METHOD &&
      Number.isSafeInteger(row.coverageSampleCount) &&
      row.coverageSampleCount >= 0,
    'Scene coverage provenance is invalid',
  );
  const exactFull =
    row.coverageStatus === SatelliteCoverageStatus.FULL &&
    row.coveragePercent === 100 &&
    row.coverageSampleCount === 0;
  const exactOutOfCoverage =
    row.coverageStatus === SatelliteCoverageStatus.OUT_OF_COVERAGE &&
    row.coveragePercent === 0 &&
    row.coverageSampleCount === 0;
  const estimatedPartial =
    row.coverageStatus === SatelliteCoverageStatus.PARTIAL &&
    ((row.coverageSampleCount === 0 && row.coveragePercent === null) ||
      (row.coverageSampleCount > 0 &&
        (row.coveragePercent === null || (row.coveragePercent > 0 && row.coveragePercent < 100))));
  contract(
    exactFull || exactOutOfCoverage || estimatedPartial,
    'Scene coverage dimensions contradict its status',
  );
  contract(
    exactOutOfCoverage
      ? row.qualityStatus === EnvironmentQualityStatus.OUT_OF_COVERAGE
      : row.qualityStatus === EnvironmentQualityStatus.VALID ||
          row.qualityStatus === EnvironmentQualityStatus.PROVISIONAL ||
          row.qualityStatus === EnvironmentQualityStatus.CLOUD_OBSCURED,
    'Scene coverage status contradicts its quality status',
  );
}

function assertCoverageContract(scope: EnvironmentSyncScopeCoverage): void {
  contract(boundedString(scope.scopeKey, 240), 'Environmental coverage scope key is invalid');
  contract(
    (scope.validFrom === null && scope.validTo === null) ||
      (scope.validFrom !== null &&
        scope.validTo !== null &&
        validDate(scope.validFrom) &&
        validDate(scope.validTo) &&
        scope.validFrom.getTime() <= scope.validTo.getTime()),
    'Environmental coverage scope window is invalid',
  );
  contract(
    Number.isInteger(scope.observationCount) && scope.observationCount >= 0,
    'Environmental coverage observation count is invalid',
  );
  const failed =
    scope.outcome === EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE ||
    scope.outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR;
  contract(
    failed
      ? scope.errorCode !== null && boundedString(scope.errorCode, 100)
      : scope.errorCode === null,
    'Environmental coverage outcome contradicts its error code',
  );
}

export function summarizeEnvironmentCoverage(
  coverage: readonly EnvironmentSyncScopeCoverage[],
): EnvironmentCoverageSummary {
  let successful = 0;
  let failed = 0;
  let noData = 0;
  let outOfCoverage = 0;
  for (const scope of coverage) {
    if (
      scope.outcome === EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE ||
      scope.outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
    ) {
      failed += 1;
    } else {
      successful += 1;
    }
    if (scope.outcome === EnvironmentSyncScopeOutcome.NO_DATA) noData += 1;
    if (scope.outcome === EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE) outOfCoverage += 1;
  }
  return {
    expected: coverage.length,
    successful,
    failed,
    noData,
    outOfCoverage,
  };
}

/**
 * Shared pre-persistence contract. Ingestion calls this while provider errors
 * can still be converted into a terminal lease outcome; the store repeats it
 * as its trust-boundary assertion so direct callers cannot bypass it.
 */
export function assertEnvironmentSyncCompletionContract(
  lease: EnvironmentSyncLease,
  completion: EnvironmentSyncCompletion,
): void {
  contract(validDate(completion.nextRunAt), 'Environmental completion next run is invalid');
  contract(
    completion.cursor === null ||
      (typeof completion.cursor === 'string' && completion.cursor.length <= 2_048),
    'Environmental completion cursor exceeds the persistence contract',
  );
  contract(
    completion.errorCode === null || boundedString(completion.errorCode, 100),
    'Environmental completion error code exceeds the persistence contract',
  );
  const successfulStatus =
    completion.status === EnvironmentSyncStatus.READY ||
    completion.status === EnvironmentSyncStatus.PARTIAL_FAILURE ||
    completion.status === EnvironmentSyncStatus.NO_DATA ||
    completion.status === EnvironmentSyncStatus.OUT_OF_COVERAGE;
  contract(
    completion.successfulProviderResponse === successfulStatus,
    'Environmental completion status contradicts provider success',
  );
  contract(
    completion.status === EnvironmentSyncStatus.PARTIAL_FAILURE
      ? completion.errorCode !== null
      : successfulStatus
        ? completion.errorCode === null
        : completion.errorCode !== null,
    'Environmental completion status contradicts its error code',
  );

  contract(completion.coverage.length > 0, 'Environmental completion has no coverage scopes');
  completion.coverage.forEach(assertCoverageContract);
  const coverageSummary = summarizeEnvironmentCoverage(completion.coverage);
  contract(
    completion.status !== EnvironmentSyncStatus.PARTIAL_FAILURE ||
      (coverageSummary.successful > 0 && coverageSummary.failed > 0),
    'PARTIAL_FAILURE requires both successful and failed coverage scopes',
  );
  contract(
    ![
      EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
      EnvironmentSyncStatus.CONFIGURATION_ERROR,
    ].includes(completion.status) ||
      (coverageSummary.successful === 0 && coverageSummary.failed > 0),
    'Failed environmental completion contains successful coverage scopes',
  );
  contract(
    ![
      EnvironmentSyncStatus.READY,
      EnvironmentSyncStatus.NO_DATA,
      EnvironmentSyncStatus.OUT_OF_COVERAGE,
    ].includes(completion.status) || coverageSummary.failed === 0,
    'Successful environmental completion contains failed coverage scopes',
  );

  const belongsToLease = (row: {
    tenantId: string;
    siteId: string;
    monitoringLocationRevision: number;
  }): boolean =>
    row.tenantId === lease.tenantId &&
    row.siteId === lease.siteId &&
    row.monitoringLocationRevision === lease.monitoringLocationRevision;
  if (
    completion.weather.some((row) => !belongsToLease(row)) ||
    completion.marine.some((row) => !belongsToLease(row)) ||
    completion.scenes.some((row) => !belongsToLease(row))
  ) {
    throw new EnvironmentCompletionContractError(
      'Environmental completion contains data outside its claimed site revision',
    );
  }
  const validProviderRows =
    lease.provider === EnvironmentProvider.MET_LOCATIONFORECAST ||
    lease.provider === EnvironmentProvider.MET_FROST
      ? completion.weather.every((row) => row.provider === lease.provider) &&
        completion.marine.length === 0 &&
        completion.scenes.length === 0
      : lease.provider === EnvironmentProvider.CMEMS
        ? completion.weather.length === 0 &&
          completion.marine.every((row) => row.provider === lease.provider) &&
          completion.scenes.length === 0
        : lease.provider === EnvironmentProvider.CDSE_SENTINEL_2
          ? completion.weather.length === 0 &&
            completion.marine.length === 0 &&
            completion.scenes.every((row) => row.provider === lease.provider)
          : false;
  if (!validProviderRows) {
    throw new EnvironmentCompletionContractError(
      'Environmental completion provider does not match its lease',
    );
  }
  completion.weather.forEach(assertWeatherContract);
  completion.marine.forEach(assertMarineContract);
  completion.scenes.forEach(assertSceneContract);

  const rowCount = completion.weather.length + completion.marine.length + completion.scenes.length;
  contract(
    completion.status !== EnvironmentSyncStatus.READY || rowCount > 0,
    'READY environmental completion has no canonical data',
  );
  contract(
    completion.status !== EnvironmentSyncStatus.NO_DATA || rowCount === 0,
    'NO_DATA environmental completion contains canonical data',
  );
  contract(
    successfulStatus || rowCount === 0,
    'Failed environmental completion contains canonical data',
  );
}

/**
 * The single persistence boundary for environmental ingestion. Provider calls
 * never enter this class, which keeps every database transaction short and
 * makes lease acquisition/completion safe across service replicas.
 */
@Injectable()
export class EnvironmentSyncStore {
  constructor(private readonly dataSource: DataSource) {}

  /** Seed missing site/provider rows once before a tenant's claim sweep. */
  async reconcileSyncStates(schema: string, tenantId: string, now: Date): Promise<void> {
    await this.inTenantTransaction(schema, tenantId, async (queryRunner) => {
      await this.seedMissingSyncStates(queryRunner, now);
    });
  }

  /**
   * Claim one bounded batch against a fixed sweep high-water mark while using
   * the fresh claim clock for lease fencing and expiry.
   */
  async claimDue(
    schema: string,
    tenantId: string,
    dueCutoff: Date,
    claimedAt: Date,
    limit: number,
    leaseDurationMs: number,
  ): Promise<EnvironmentSyncLease[]> {
    if (!validDate(dueCutoff) || !validDate(claimedAt)) {
      throw new RangeError('environment sync claim clocks must be valid dates');
    }
    if (claimedAt.getTime() < dueCutoff.getTime()) {
      throw new RangeError('environment sync claim clock cannot precede its sweep cutoff');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('environment sync claim limit must be between 1 and 100');
    }
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 60_000) {
      throw new RangeError('environment sync lease must be at least one minute');
    }

    return this.inTenantTransaction(schema, tenantId, async (queryRunner) => {
      const rows: LeaseDatabaseRow[] = await queryRunner.query(
        `
          WITH due AS (
            SELECT state.id
            FROM site_environment_sync_state AS state
            INNER JOIN sites AS site
              ON site.id = state.site_id
             AND site."tenantId" = state.tenant_id
             AND site."monitoringLocationRevision" =
                 state.monitoring_location_revision
            WHERE site."type"::text = 'sea_cage'
              AND site."isActive" = TRUE
              AND site."isDeleted" = FALSE
              AND state.provider = ANY($1::varchar[])
              AND (state.next_run_at IS NULL OR state.next_run_at <= $2)
              AND (state.last_attempt_at IS NULL OR state.last_attempt_at < $2)
              AND (state.lease_expires_at IS NULL OR state.lease_expires_at <= $3)
              AND jsonb_typeof(site.location) = 'object'
              AND jsonb_typeof(site.location->'latitude') = 'number'
              AND jsonb_typeof(site.location->'longitude') = 'number'
              AND (site.location->>'latitude')::double precision BETWEEN -90 AND 90
              AND (site.location->>'longitude')::double precision BETWEEN -180 AND 180
            ORDER BY state.next_run_at NULLS FIRST, state.updated_at, state.id
            FOR UPDATE OF state SKIP LOCKED
            LIMIT $4
          ),
          claimed AS (
            UPDATE site_environment_sync_state AS state
               SET status = 'RUNNING',
                   lease_token = uuid_generate_v4(),
                   lease_expires_at =
                     $3 + ($5::integer * interval '1 millisecond'),
                   last_attempt_at = $3,
                   updated_at = $3
              FROM due
             WHERE state.id = due.id
            RETURNING state.*
          )
          SELECT
            current_schema() AS schema_name,
            claimed.tenant_id,
            claimed.site_id,
            claimed.provider,
            claimed.lease_token,
            claimed.monitoring_location_revision,
            (site.location->>'latitude')::double precision AS latitude,
            (site.location->>'longitude')::double precision AS longitude,
            CASE
              WHEN jsonb_typeof(site.location->'altitude') = 'number'
              THEN (site.location->>'altitude')::double precision
              ELSE NULL
            END AS altitude_m,
            site."monitoringRadiusM" AS monitoring_radius_m,
            site."monitoringArea" AS monitoring_area,
            claimed.cursor,
            claimed.consecutive_failures
          FROM claimed
          INNER JOIN sites AS site
            ON site.id = claimed.site_id
           AND site."tenantId" = claimed.tenant_id
           AND site."monitoringLocationRevision" =
               claimed.monitoring_location_revision
          ORDER BY claimed.last_attempt_at, claimed.id
        `,
        [CANONICAL_SYNC_PROVIDERS, dueCutoff, claimedAt, limit, leaseDurationMs],
      );

      return rows.map((row) => this.mapLease(row, schema));
    });
  }

  async measureDueBacklog(
    schema: string,
    tenantId: string,
    now: Date,
  ): Promise<EnvironmentDueBacklog> {
    return this.inTenantTransaction(schema, tenantId, async (queryRunner) => {
      const rows: Array<{ due_count: string | number; oldest_due_at: Date | string | null }> =
        await queryRunner.query(
          `
            SELECT COUNT(*)::text AS due_count,
                   MIN(COALESCE(state.next_run_at, $2)) AS oldest_due_at
            FROM site_environment_sync_state AS state
            INNER JOIN sites AS site
              ON site.id = state.site_id
             AND site."tenantId" = state.tenant_id
             AND site."monitoringLocationRevision" = state.monitoring_location_revision
            WHERE site."type"::text = 'sea_cage'
              AND site."isActive" = TRUE
              AND site."isDeleted" = FALSE
              AND state.provider = ANY($1::varchar[])
              AND (state.next_run_at IS NULL OR state.next_run_at <= $2)
              AND (state.lease_expires_at IS NULL OR state.lease_expires_at <= $2)
          `,
          [CANONICAL_SYNC_PROVIDERS, now],
        );
      const row = rows[0];
      const dueCount = Number(row?.due_count ?? 0);
      if (!Number.isInteger(dueCount) || dueCount < 0) {
        throw new Error('Environmental due backlog returned an invalid count');
      }
      const oldestDueAt = row?.oldest_due_at ? new Date(row.oldest_due_at) : null;
      if (oldestDueAt && !Number.isFinite(oldestDueAt.getTime())) {
        throw new Error('Environmental due backlog returned an invalid timestamp');
      }
      return { dueCount, oldestDueAt };
    });
  }

  async complete(
    lease: EnvironmentSyncLease,
    completion: EnvironmentSyncCompletion,
    completedAt: Date,
  ): Promise<boolean> {
    assertEnvironmentSyncCompletionContract(lease, completion);
    return this.inTenantTransaction(lease.schema, lease.tenantId, async (queryRunner) => {
      const locked: LockedLeaseRow[] = await queryRunner.query(
        `
          SELECT state.id
          FROM site_environment_sync_state AS state
          INNER JOIN sites AS site
            ON site.id = state.site_id
           AND site."tenantId" = state.tenant_id
          WHERE state.tenant_id = $1
            AND state.site_id = $2
            AND state.provider = $3
            AND state.lease_token = $4
            AND state.status = 'RUNNING'
            AND state.lease_expires_at > $6
            AND state.monitoring_location_revision = $5
            AND site."monitoringLocationRevision" = $5
            AND site."type"::text = 'sea_cage'
            AND site."isActive" = TRUE
            AND site."isDeleted" = FALSE
          FOR UPDATE OF state, site
        `,
        [
          lease.tenantId,
          lease.siteId,
          lease.provider,
          lease.token,
          lease.monitoringLocationRevision,
          completedAt,
        ],
      );
      if (locked.length !== 1) {
        return false;
      }

      await this.insertWeather(queryRunner, completion.weather);
      await this.insertMarine(queryRunner, completion.marine);
      await this.insertScenes(queryRunner, completion.scenes);
      await this.replaceCoverage(queryRunner, lease, completion.coverage, completedAt);

      const coverageSummary = summarizeEnvironmentCoverage(completion.coverage);

      const updated: LockedLeaseRow[] = await queryRunner.query(
        `
          WITH updated AS (
            UPDATE site_environment_sync_state
               SET status = $6,
                   cursor = $7,
                   last_success_at = CASE WHEN $8 THEN $9 ELSE last_success_at END,
                   next_run_at = $10,
                   error_code = $11,
                   expected_scope_count = $12,
                   successful_scope_count = $13,
                   failed_scope_count = $14,
                   no_data_scope_count = $15,
                   out_of_coverage_scope_count = $16,
                   consecutive_failures =
                     CASE WHEN $8 THEN 0 ELSE consecutive_failures + 1 END,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = $9
             WHERE tenant_id = $1
               AND site_id = $2
               AND provider = $3
               AND lease_token = $4
               AND monitoring_location_revision = $5
            RETURNING id
          )
          SELECT id FROM updated
        `,
        [
          lease.tenantId,
          lease.siteId,
          lease.provider,
          lease.token,
          lease.monitoringLocationRevision,
          completion.status,
          completion.cursor,
          completion.successfulProviderResponse,
          completedAt,
          completion.nextRunAt,
          completion.errorCode,
          coverageSummary.expected,
          coverageSummary.successful,
          coverageSummary.failed,
          coverageSummary.noData,
          coverageSummary.outOfCoverage,
        ],
      );
      if (updated.length !== 1) {
        throw new Error('Environmental sync state update was lost after a fenced lease lock');
      }
      return true;
    });
  }

  async retainSchema(
    schema: string,
    tenantId: string,
    cutoff: Date,
  ): Promise<EnvironmentRetentionResult> {
    return this.inTenantTransaction(schema, tenantId, async (queryRunner) => {
      // Cron decorators coordinate only inside one process. A transaction-
      // scoped advisory lock makes the tenant retention sweep single-owner
      // across replicas, while try-lock lets the losing replica move on.
      // Bound both row-lock waits and each delete statement so a competing
      // writer cannot permanently wedge this daily lifecycle job.
      await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
      await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
      const lockRows: Array<{ acquired: unknown }> = await queryRunner.query(
        `SELECT pg_try_advisory_xact_lock(
           hashtext('aqua:environment-retention'),
           hashtext($1)
         ) AS acquired`,
        [tenantId],
      );
      if (lockRows.length !== 1 || typeof lockRows[0]?.acquired !== 'boolean') {
        throw new Error('Environmental retention lock failed database contract validation');
      }
      if (!lockRows[0].acquired) {
        return {
          weatherDeleted: 0,
          marineDeleted: 0,
          scenesDeleted: 0,
          obsoleteStatesDeleted: 0,
        };
      }

      const weatherDeleted = await this.deleteCount(
        queryRunner,
        `DELETE FROM weather_observations WHERE provider IS NOT NULL AND observed_at < $1`,
        cutoff,
      );
      const marineDeleted = await this.deleteCount(
        queryRunner,
        `DELETE FROM marine_observations WHERE provider IS NOT NULL AND observed_at < $1`,
        cutoff,
      );
      const scenesDeleted = await this.deleteCount(
        queryRunner,
        `DELETE FROM satellite_scene_observations WHERE acquired_at < $1`,
        cutoff,
      );
      const obsoleteStatesDeleted = await this.deleteCount(
        queryRunner,
        `
          DELETE FROM site_environment_sync_state AS state
          USING sites AS site
          WHERE state.site_id = site.id
            AND state.tenant_id = site."tenantId"
            AND (
              state.monitoring_location_revision <> site."monitoringLocationRevision"
              OR site."isActive" = FALSE
              OR site."isDeleted" = TRUE
              OR site."type"::text <> 'sea_cage'
            )
            AND state.updated_at < $1
            AND (state.lease_expires_at IS NULL OR state.lease_expires_at < $1)
        `,
        cutoff,
      );
      return {
        weatherDeleted,
        marineDeleted,
        scenesDeleted,
        obsoleteStatesDeleted,
      };
    });
  }

  private async inTenantTransaction<T>(
    schema: string,
    tenantId: string,
    work: (queryRunner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    assertSafeSchemaName(schema);
    if (getTenantSchemaName(tenantId) !== schema) {
      throw new Error('Environmental sync tenant identity does not match its schema');
    }
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, work);
  }

  private mapLease(row: LeaseDatabaseRow, requestedSchema: string): EnvironmentSyncLease {
    if (
      row.schema_name !== requestedSchema ||
      !isCanonicalEnvironmentProvider(row.provider) ||
      !Number.isFinite(row.latitude) ||
      row.latitude < -90 ||
      row.latitude > 90 ||
      !Number.isFinite(row.longitude) ||
      row.longitude < -180 ||
      row.longitude > 180 ||
      !Number.isInteger(row.monitoring_location_revision) ||
      row.monitoring_location_revision < 1 ||
      !Number.isInteger(row.monitoring_radius_m) ||
      row.monitoring_radius_m < 100 ||
      row.monitoring_radius_m > 20_000 ||
      !Number.isInteger(row.consecutive_failures) ||
      row.consecutive_failures < 0
    ) {
      throw new Error('Environmental sync lease failed database contract validation');
    }
    return {
      schema: requestedSchema,
      tenantId: row.tenant_id,
      siteId: row.site_id,
      provider: row.provider,
      token: row.lease_token,
      monitoringLocationRevision: row.monitoring_location_revision,
      latitude: row.latitude,
      longitude: row.longitude,
      altitudeM: row.altitude_m,
      monitoringRadiusM: row.monitoring_radius_m,
      monitoringArea: row.monitoring_area,
      cursor: row.cursor,
      consecutiveFailures: row.consecutive_failures,
    };
  }

  private async insertWeather(
    queryRunner: QueryRunner,
    rows: readonly CanonicalWeatherInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await queryRunner.query(
      `
        INSERT INTO weather_observations (
          tenant_id, site_id, observed_at, data_type, provider, product_id,
          dataset_id, source_run_key, issued_at, semantic_class, quality_status,
          station_id, station_distance_km, horizontal_resolution_m,
          monitoring_location_revision, temperature, wind_speed, wind_direction,
          wind_gusts, precipitation, cloud_cover, pressure_msl,
          relative_humidity, fetched_at
        )
        SELECT
          source.tenant_id, source.site_id, source.observed_at, source.data_type,
          source.provider, source.product_id, source.dataset_id,
          source.source_run_key, source.issued_at, source.semantic_class,
          source.quality_status, source.station_id, source.station_distance_km,
          source.horizontal_resolution_m, source.monitoring_location_revision,
          source.temperature, source.wind_speed, source.wind_direction,
          source.wind_gusts, source.precipitation, source.cloud_cover,
          source.pressure_msl, source.relative_humidity, source.fetched_at
        FROM jsonb_to_recordset($1::jsonb) AS source(
          tenant_id uuid,
          site_id uuid,
          observed_at timestamptz,
          data_type varchar,
          provider varchar,
          product_id varchar,
          dataset_id varchar,
          source_run_key varchar,
          issued_at timestamptz,
          semantic_class varchar,
          quality_status varchar,
          station_id varchar,
          station_distance_km numeric,
          horizontal_resolution_m numeric,
          monitoring_location_revision integer,
          temperature numeric,
          wind_speed numeric,
          wind_direction numeric,
          wind_gusts numeric,
          precipitation numeric,
          cloud_cover numeric,
          pressure_msl numeric,
          relative_humidity numeric,
          fetched_at timestamptz
        )
        ON CONFLICT (
          tenant_id, site_id, provider, dataset_id, source_run_key,
          observed_at, data_type, monitoring_location_revision
        ) WHERE provider IS NOT NULL DO NOTHING
      `,
      [JSON.stringify(rows.map((row) => this.weatherJson(row)))],
    );
  }

  private async replaceCoverage(
    queryRunner: QueryRunner,
    lease: EnvironmentSyncLease,
    coverage: readonly EnvironmentSyncScopeCoverage[],
    completedAt: Date,
  ): Promise<void> {
    await queryRunner.query(
      `
        DELETE FROM environment_metric_sync_outcomes
        WHERE tenant_id = $1
          AND site_id = $2
          AND provider = $3
          AND monitoring_location_revision = $4
      `,
      [lease.tenantId, lease.siteId, lease.provider, lease.monitoringLocationRevision],
    );
    await queryRunner.query(
      `
        INSERT INTO environment_metric_sync_outcomes (
          tenant_id, site_id, provider, metric, scope_kind, scope_key,
          valid_from, valid_to, outcome, error_code, observation_count,
          monitoring_location_revision, completed_at
        )
        SELECT
          $1, $2, $3, source.metric, source.scope_kind, source.scope_key,
          source.valid_from, source.valid_to, source.outcome, source.error_code,
          source.observation_count, $4, $5
        FROM unnest(
          $6::varchar[],
          $7::varchar[],
          $8::varchar[],
          $9::timestamptz[],
          $10::timestamptz[],
          $11::varchar[],
          $12::varchar[],
          $13::integer[]
        ) AS source(
          metric, scope_kind, scope_key, valid_from, valid_to, outcome,
          error_code, observation_count
        )
      `,
      [
        lease.tenantId,
        lease.siteId,
        lease.provider,
        lease.monitoringLocationRevision,
        completedAt,
        coverage.map((scope) => scope.metric),
        coverage.map((scope) => scope.scopeKind),
        coverage.map((scope) => scope.scopeKey),
        coverage.map((scope) => scope.validFrom),
        coverage.map((scope) => scope.validTo),
        coverage.map((scope) => scope.outcome),
        coverage.map((scope) => scope.errorCode),
        coverage.map((scope) => scope.observationCount),
      ],
    );
  }

  private async insertMarine(
    queryRunner: QueryRunner,
    rows: readonly CanonicalMarineInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await queryRunner.query(
      `
        INSERT INTO marine_observations (
          tenant_id, site_id, observed_at, data_type, provider, product_id,
          dataset_id, variable_set_id, source_run_key, issued_at,
          semantic_class, quality_status, wave_height, wave_direction,
          wave_period, ocean_current_velocity, ocean_current_direction,
          sea_surface_temperature, salinity, dissolved_oxygen,
          model_chlorophyll, requested_depth_m, model_depth_m,
          horizontal_resolution_m, grid_cell_distance_m, coverage_percent,
          monitoring_location_revision, fetched_at
        )
        SELECT
          source.tenant_id, source.site_id, source.observed_at, source.data_type,
          source.provider, source.product_id, source.dataset_id,
          source.variable_set_id, source.source_run_key, source.issued_at,
          source.semantic_class, source.quality_status, source.wave_height,
          source.wave_direction, source.wave_period,
          source.ocean_current_velocity, source.ocean_current_direction,
          source.sea_surface_temperature, source.salinity,
          source.dissolved_oxygen, source.model_chlorophyll,
          source.requested_depth_m, source.model_depth_m,
          source.horizontal_resolution_m, source.grid_cell_distance_m,
          source.coverage_percent, source.monitoring_location_revision,
          source.fetched_at
        FROM jsonb_to_recordset($1::jsonb) AS source(
          tenant_id uuid,
          site_id uuid,
          observed_at timestamptz,
          data_type varchar,
          provider varchar,
          product_id varchar,
          dataset_id varchar,
          variable_set_id varchar,
          source_run_key varchar,
          issued_at timestamptz,
          semantic_class varchar,
          quality_status varchar,
          wave_height numeric,
          wave_direction numeric,
          wave_period numeric,
          ocean_current_velocity numeric,
          ocean_current_direction numeric,
          sea_surface_temperature numeric,
          salinity numeric,
          dissolved_oxygen numeric,
          model_chlorophyll numeric,
          requested_depth_m numeric,
          model_depth_m numeric,
          horizontal_resolution_m numeric,
          grid_cell_distance_m numeric,
          coverage_percent numeric,
          monitoring_location_revision integer,
          fetched_at timestamptz
        )
        ON CONFLICT (
          tenant_id, site_id, provider, dataset_id, source_run_key,
          observed_at, data_type, COALESCE(model_depth_m, -1),
          monitoring_location_revision
        ) WHERE provider IS NOT NULL DO NOTHING
      `,
      [JSON.stringify(rows.map((row) => this.marineJson(row)))],
    );
  }

  private async insertScenes(
    queryRunner: QueryRunner,
    rows: readonly CanonicalSatelliteSceneInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const sceneObservations = JSON.stringify(rows.map((row) => this.sceneJson(row)));
    await queryRunner.query(
      `
        INSERT INTO satellite_scene_observations (
          tenant_id, site_id, scene_id, collection, provider, product_id,
          dataset_id, acquired_at, cloud_cover_percent, coverage_percent,
          quality_status, monitoring_location_revision, fetched_at
        )
        SELECT
          source.tenant_id, source.site_id, source.scene_id, source.collection,
          source.provider, source.product_id, source.dataset_id,
          source.acquired_at, source.cloud_cover_percent,
          source.coverage_percent, source.quality_status,
          source.monitoring_location_revision, source.fetched_at
        FROM jsonb_to_recordset($1::jsonb) AS source(
          tenant_id uuid,
          site_id uuid,
          scene_id varchar,
          collection varchar,
          provider varchar,
          product_id varchar,
          dataset_id varchar,
          acquired_at timestamptz,
          cloud_cover_percent numeric,
          coverage_percent numeric,
          quality_status varchar,
          monitoring_location_revision integer,
          fetched_at timestamptz
        )
        ON CONFLICT (
          tenant_id, site_id, scene_id, monitoring_location_revision
        ) DO NOTHING
      `,
      [sceneObservations],
    );

    // fetched_at is the immutable row's first-seen timestamp and
    // coverage_percent and quality_status are rolling-release legacy
    // projections. A later catalog fetch legitimately has a new fetch time,
    // while versioned coverage is verified below in its own SSOT. Every
    // provider-owned raw acquisition fact must still match exactly before the
    // cursor advances.
    const sceneConflicts: Array<{ scene_id: string }> = await queryRunner.query(
      `
        SELECT source.scene_id
        FROM jsonb_to_recordset($1::jsonb) AS source(
          tenant_id uuid,
          site_id uuid,
          scene_id varchar,
          collection varchar,
          provider varchar,
          product_id varchar,
          dataset_id varchar,
          acquired_at timestamptz,
          cloud_cover_percent numeric,
          coverage_percent numeric,
          quality_status varchar,
          monitoring_location_revision integer,
          fetched_at timestamptz
        )
        LEFT JOIN satellite_scene_observations AS persisted
          ON persisted.tenant_id = source.tenant_id
         AND persisted.site_id = source.site_id
         AND persisted.scene_id = source.scene_id
         AND persisted.monitoring_location_revision =
             source.monitoring_location_revision
        WHERE persisted.id IS NULL
           OR persisted.collection IS DISTINCT FROM source.collection
           OR persisted.provider IS DISTINCT FROM source.provider
           OR persisted.product_id IS DISTINCT FROM source.product_id
           OR persisted.dataset_id IS DISTINCT FROM source.dataset_id
           OR persisted.acquired_at IS DISTINCT FROM source.acquired_at
           OR persisted.cloud_cover_percent IS DISTINCT FROM
              CAST(source.cloud_cover_percent AS numeric(5,2))
      `,
      [sceneObservations],
    );
    if (sceneConflicts.length > 0) {
      throw new EnvironmentCompletionContractError(
        'Satellite scene conflicts with immutable persisted acquisition facts',
      );
    }

    const assessments = JSON.stringify(rows.map((row) => this.sceneCoverageJson(row)));
    await queryRunner.query(
      `
        INSERT INTO satellite_scene_coverage_assessments (
          tenant_id, site_id, scene_id, monitoring_location_revision,
          coverage_status, coverage_method, coverage_percent,
          coverage_sample_count, quality_status
        )
        SELECT
          source.tenant_id, source.site_id, source.scene_id,
          source.monitoring_location_revision, source.coverage_status,
          source.coverage_method, source.coverage_percent,
          source.coverage_sample_count, source.quality_status
        FROM jsonb_to_recordset($1::jsonb) AS source(
          tenant_id uuid,
          site_id uuid,
          scene_id varchar,
          monitoring_location_revision integer,
          coverage_status varchar,
          coverage_method varchar,
          coverage_percent numeric,
          coverage_sample_count integer,
          quality_status varchar
        )
        ON CONFLICT (
          tenant_id, site_id, scene_id, monitoring_location_revision,
          coverage_method
        ) DO NOTHING
      `,
      [assessments],
    );

    const conflicts: Array<{ scene_id: string; coverage_method: string }> = await queryRunner.query(
      `
          SELECT source.scene_id, source.coverage_method
          FROM jsonb_to_recordset($1::jsonb) AS source(
            tenant_id uuid,
            site_id uuid,
            scene_id varchar,
            monitoring_location_revision integer,
            coverage_status varchar,
            coverage_method varchar,
            coverage_percent numeric,
            coverage_sample_count integer,
            quality_status varchar
          )
          LEFT JOIN satellite_scene_coverage_assessments AS persisted
            ON persisted.tenant_id = source.tenant_id
           AND persisted.site_id = source.site_id
           AND persisted.scene_id = source.scene_id
           AND persisted.monitoring_location_revision =
               source.monitoring_location_revision
           AND persisted.coverage_method = source.coverage_method
          WHERE persisted.id IS NULL
             OR persisted.coverage_status IS DISTINCT FROM source.coverage_status
             OR persisted.coverage_percent IS DISTINCT FROM
                CAST(source.coverage_percent AS numeric(5,2))
             OR persisted.coverage_sample_count IS DISTINCT FROM
                source.coverage_sample_count
             OR persisted.quality_status IS DISTINCT FROM source.quality_status
        `,
      [assessments],
    );
    if (conflicts.length > 0) {
      throw new EnvironmentCompletionContractError(
        'Satellite coverage assessment conflicts with immutable persisted provenance',
      );
    }
  }

  private weatherJson(row: CanonicalWeatherInsert): Record<string, string | number | null> {
    return {
      tenant_id: row.tenantId,
      site_id: row.siteId,
      observed_at: row.observedAt.toISOString(),
      data_type: row.dataType,
      provider: row.provider,
      product_id: row.productId,
      dataset_id: row.datasetId,
      source_run_key: row.sourceRunKey,
      issued_at: row.issuedAt?.toISOString() ?? null,
      semantic_class: row.semanticClass,
      quality_status: row.qualityStatus,
      station_id: row.stationId,
      station_distance_km: row.stationDistanceKm,
      horizontal_resolution_m: row.horizontalResolutionM,
      monitoring_location_revision: row.monitoringLocationRevision,
      temperature: row.temperature,
      wind_speed: row.windSpeed,
      wind_direction: row.windDirection,
      wind_gusts: row.windGusts,
      precipitation: row.precipitation,
      cloud_cover: row.cloudCover,
      pressure_msl: row.pressureMsl,
      relative_humidity: row.relativeHumidity,
      fetched_at: row.fetchedAt.toISOString(),
    };
  }

  private marineJson(row: CanonicalMarineInsert): Record<string, string | number | null> {
    return {
      tenant_id: row.tenantId,
      site_id: row.siteId,
      observed_at: row.observedAt.toISOString(),
      data_type: row.dataType,
      provider: row.provider,
      product_id: row.productId,
      dataset_id: row.datasetId,
      variable_set_id: row.variableSetId,
      source_run_key: row.sourceRunKey,
      issued_at: row.issuedAt?.toISOString() ?? null,
      semantic_class: row.semanticClass,
      quality_status: row.qualityStatus,
      wave_height: row.waveHeight,
      wave_direction: row.waveDirection,
      wave_period: row.wavePeriod,
      ocean_current_velocity: row.oceanCurrentVelocity,
      ocean_current_direction: row.oceanCurrentDirection,
      sea_surface_temperature: row.seaSurfaceTemperature,
      salinity: row.salinity,
      dissolved_oxygen: row.dissolvedOxygen,
      model_chlorophyll: row.modelChlorophyll,
      requested_depth_m: row.requestedDepthM,
      model_depth_m: row.modelDepthM,
      horizontal_resolution_m: row.horizontalResolutionM,
      grid_cell_distance_m: row.gridCellDistanceM,
      coverage_percent: row.coveragePercent,
      monitoring_location_revision: row.monitoringLocationRevision,
      fetched_at: row.fetchedAt.toISOString(),
    };
  }

  private sceneJson(row: CanonicalSatelliteSceneInsert): Record<string, string | number | null> {
    return {
      tenant_id: row.tenantId,
      site_id: row.siteId,
      scene_id: row.sceneId,
      collection: row.collection,
      provider: row.provider,
      product_id: row.productId,
      dataset_id: row.datasetId,
      acquired_at: row.acquiredAt.toISOString(),
      cloud_cover_percent: row.cloudCoverPercent,
      coverage_percent: row.coveragePercent,
      quality_status: row.qualityStatus,
      monitoring_location_revision: row.monitoringLocationRevision,
      fetched_at: row.fetchedAt.toISOString(),
    };
  }

  private sceneCoverageJson(
    row: CanonicalSatelliteSceneInsert,
  ): Record<string, string | number | null> {
    return {
      tenant_id: row.tenantId,
      site_id: row.siteId,
      scene_id: row.sceneId,
      monitoring_location_revision: row.monitoringLocationRevision,
      coverage_status: row.coverageStatus,
      coverage_method: row.coverageMethod,
      coverage_percent: row.coveragePercent,
      coverage_sample_count: row.coverageSampleCount,
      quality_status: row.qualityStatus,
    };
  }

  private async seedMissingSyncStates(queryRunner: QueryRunner, now: Date): Promise<void> {
    await queryRunner.query(
      `
        INSERT INTO site_environment_sync_state (
          tenant_id,
          site_id,
          provider,
          status,
          monitoring_location_revision,
          next_run_at
        )
        SELECT
          site."tenantId",
          site.id,
          provider.name,
          'PENDING',
          site."monitoringLocationRevision",
          $1
        FROM sites AS site
        CROSS JOIN unnest($2::varchar[]) AS provider(name)
        WHERE site."type"::text = 'sea_cage'
          AND site."isActive" = TRUE
          AND site."isDeleted" = FALSE
          AND jsonb_typeof(site.location) = 'object'
          AND jsonb_typeof(site.location->'latitude') = 'number'
          AND jsonb_typeof(site.location->'longitude') = 'number'
          AND (site.location->>'latitude')::double precision BETWEEN -90 AND 90
          AND (site.location->>'longitude')::double precision BETWEEN -180 AND 180
        ON CONFLICT (
          tenant_id,
          site_id,
          provider,
          monitoring_location_revision
        ) DO NOTHING
      `,
      [now, CANONICAL_SYNC_PROVIDERS],
    );
  }

  private async deleteCount(
    queryRunner: QueryRunner,
    statement: string,
    cutoff: Date,
  ): Promise<number> {
    const result: [unknown[], number] = await queryRunner.query(statement, [cutoff]);
    return typeof result[1] === 'number' ? result[1] : 0;
  }
}
