import { registerEnumType } from '@nestjs/graphql';

export enum EnvironmentProvider {
  MET_LOCATIONFORECAST = 'MET_LOCATIONFORECAST',
  MET_FROST = 'MET_FROST',
  CMEMS = 'CMEMS',
  CDSE_SENTINEL_2 = 'CDSE_SENTINEL_2',
}

export type CanonicalEnvironmentProvider = EnvironmentProvider;

/**
 * Canonical providers allowed to participate in the tenant environment SSoT.
 */
export const CANONICAL_WEATHER_PROVIDERS: readonly CanonicalEnvironmentProvider[] = Object.freeze([
  EnvironmentProvider.MET_LOCATIONFORECAST,
  EnvironmentProvider.MET_FROST,
]);

export const CANONICAL_MARINE_PROVIDERS: readonly CanonicalEnvironmentProvider[] = Object.freeze([
  EnvironmentProvider.CMEMS,
]);

export const CANONICAL_SYNC_PROVIDERS: readonly CanonicalEnvironmentProvider[] = Object.freeze([
  ...CANONICAL_WEATHER_PROVIDERS,
  ...CANONICAL_MARINE_PROVIDERS,
  EnvironmentProvider.CDSE_SENTINEL_2,
]);
const CANONICAL_SYNC_PROVIDER_SET: ReadonlySet<string> = new Set(CANONICAL_SYNC_PROVIDERS);

export function isCanonicalEnvironmentProvider(
  provider: string,
): provider is CanonicalEnvironmentProvider {
  return CANONICAL_SYNC_PROVIDER_SET.has(provider);
}

export enum EnvironmentSemanticClass {
  OBSERVATION = 'OBSERVATION',
  ANALYSIS = 'ANALYSIS',
  FORECAST = 'FORECAST',
  SATELLITE_ACQUISITION = 'SATELLITE_ACQUISITION',
  INDICATOR = 'INDICATOR',
  IMAGERY = 'IMAGERY',
}

export enum EnvironmentQualityStatus {
  VALID = 'VALID',
  PROVISIONAL = 'PROVISIONAL',
  NO_DATA = 'NO_DATA',
  CLOUD_OBSCURED = 'CLOUD_OBSCURED',
  OUT_OF_COVERAGE = 'OUT_OF_COVERAGE',
  STALE = 'STALE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

/**
 * Persisted relationship between a Sentinel scene footprint and the site's
 * monitoring AOI. UNKNOWN is reserved for rows written before coverage
 * provenance became part of the canonical scene contract.
 */
export const SatelliteCoverageStatus = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  FULL: 'FULL',
  PARTIAL: 'PARTIAL',
  OUT_OF_COVERAGE: 'OUT_OF_COVERAGE',
} as const);
export type SatelliteCoverageStatus =
  (typeof SatelliteCoverageStatus)[keyof typeof SatelliteCoverageStatus];

/** Explicit provenance marker assigned only to pre-contract scene rows. */
export const SATELLITE_COVERAGE_LEGACY_METHOD = 'LEGACY_UNKNOWN';

export enum EnvironmentMetric {
  AIR_TEMPERATURE = 'AIR_TEMPERATURE',
  WIND_SPEED = 'WIND_SPEED',
  WIND_DIRECTION = 'WIND_DIRECTION',
  WIND_GUST = 'WIND_GUST',
  PRECIPITATION = 'PRECIPITATION',
  CLOUD_COVER = 'CLOUD_COVER',
  PRESSURE_MSL = 'PRESSURE_MSL',
  RELATIVE_HUMIDITY = 'RELATIVE_HUMIDITY',
  WAVE_HEIGHT = 'WAVE_HEIGHT',
  WAVE_DIRECTION = 'WAVE_DIRECTION',
  WAVE_PERIOD = 'WAVE_PERIOD',
  CURRENT_SPEED = 'CURRENT_SPEED',
  CURRENT_DIRECTION = 'CURRENT_DIRECTION',
  SEA_TEMPERATURE = 'SEA_TEMPERATURE',
  SALINITY = 'SALINITY',
  DISSOLVED_OXYGEN = 'DISSOLVED_OXYGEN',
  MODEL_CHLOROPHYLL = 'MODEL_CHLOROPHYLL',
}

export enum EnvironmentSyncStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  READY = 'READY',
  PARTIAL_FAILURE = 'PARTIAL_FAILURE',
  NO_DATA = 'NO_DATA',
  OUT_OF_COVERAGE = 'OUT_OF_COVERAGE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export enum EnvironmentAvailabilityStatus {
  PREPARING = 'PREPARING',
  READY = 'READY',
  PARTIAL_FAILURE = 'PARTIAL_FAILURE',
  PARTIAL_COVERAGE = 'PARTIAL_COVERAGE',
  NO_DATA = 'NO_DATA',
  CLOUD_OBSCURED = 'CLOUD_OBSCURED',
  OUT_OF_COVERAGE = 'OUT_OF_COVERAGE',
  STALE = 'STALE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export enum EnvironmentSyncScopeKind {
  PROVIDER_RUN = 'PROVIDER_RUN',
  METRIC_SUMMARY = 'METRIC_SUMMARY',
  METRIC_HORIZON = 'METRIC_HORIZON',
  METRIC_INTERVAL = 'METRIC_INTERVAL',
}

export enum EnvironmentSyncScopeOutcome {
  AVAILABLE = 'AVAILABLE',
  NO_DATA = 'NO_DATA',
  OUT_OF_COVERAGE = 'OUT_OF_COVERAGE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export interface EnvironmentSyncScopeCoverage {
  scopeKind: EnvironmentSyncScopeKind;
  scopeKey: string;
  metric: EnvironmentMetric | null;
  validFrom: Date | null;
  validTo: Date | null;
  outcome: EnvironmentSyncScopeOutcome;
  errorCode: string | null;
  observationCount: number;
}

export enum EnvironmentLayerCapability {
  IMAGERY = 'IMAGERY',
  HISTORY = 'HISTORY',
  FORECAST = 'FORECAST',
}

registerEnumType(EnvironmentProvider, { name: 'EnvironmentProvider' });
registerEnumType(EnvironmentSemanticClass, { name: 'EnvironmentSemanticClass' });
registerEnumType(EnvironmentQualityStatus, { name: 'EnvironmentQualityStatus' });
registerEnumType(SatelliteCoverageStatus, { name: 'SatelliteCoverageStatus' });
registerEnumType(EnvironmentMetric, { name: 'EnvironmentMetric' });
registerEnumType(EnvironmentSyncStatus, { name: 'EnvironmentSyncStatus' });
registerEnumType(EnvironmentAvailabilityStatus, { name: 'EnvironmentAvailabilityStatus' });
registerEnumType(EnvironmentLayerCapability, { name: 'EnvironmentLayerCapability' });
registerEnumType(EnvironmentSyncScopeKind, { name: 'EnvironmentSyncScopeKind' });
registerEnumType(EnvironmentSyncScopeOutcome, { name: 'EnvironmentSyncScopeOutcome' });
