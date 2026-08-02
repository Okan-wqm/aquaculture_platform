import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { createSiteMonitoringCircle } from '../../site/site-monitoring-geometry';
import {
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeCoverage,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
} from '../entities/environment-observation.types';
import { WeatherDataType } from '../entities/weather-observation.entity';
import {
  CdseProviderError,
  CdseProviderErrorCode,
  CdseSceneObservationCandidate,
  CdseSentinelProvider,
} from './cdse-sentinel.provider';
import {
  CMEMS_ENVIRONMENT_METRICS,
  CmemsEnvironmentValue,
  CmemsRegionalResult,
  CmemsRegionalService,
} from './cmems-regional.service';
import { CmemsProviderError, CmemsProviderErrorCode } from './cmems-provider';
import { EnvironmentProviderConfigurationService } from './environment-provider-configuration.service';
import { EnvironmentMonitoringGate } from './environment-monitoring-gate.service';
import {
  CanonicalMarineInsert,
  CanonicalSatelliteSceneInsert,
  CanonicalWeatherInsert,
  EnvironmentCompletionContractError,
  EnvironmentSyncCompletion,
  EnvironmentSyncLease,
  EnvironmentSyncStore,
  assertEnvironmentSyncCompletionContract,
  summarizeEnvironmentCoverage,
} from './environment-sync-store.service';
import {
  FrostElementId,
  FrostHistoryAvailable,
  FrostObservation,
  FrostObservationsService,
  FrostQualityStatus,
} from './frost-observations.service';
import {
  MetLocationForecastAvailable,
  MetLocationForecastMeasurement,
  MetLocationForecastObservation,
  MetLocationForecastService,
} from './met-locationforecast.service';
import {
  MetNorwayProvider,
  MetNorwayProviderError,
  MetNorwayProviderErrorCode,
} from './met-norway-provider';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LOCATIONFORECAST_INTERVAL_MS = HOUR_MS;
const FROST_INTERVAL_MS = 6 * HOUR_MS;
const CMEMS_INTERVAL_MS = 3 * HOUR_MS;
const CDSE_INTERVAL_MS = 6 * HOUR_MS;
const OUT_OF_COVERAGE_INTERVAL_MS = DAY_MS;
const CONFIGURATION_RECHECK_MS = DAY_MS;
const BASE_FAILURE_BACKOFF_MS = 15 * MINUTE_MS;
const MAX_FAILURE_BACKOFF_MS = 6 * HOUR_MS;
const CMEMS_HORIZON_STEP_MS = 12 * HOUR_MS;
const CMEMS_HORIZON_COUNT = 15;
const CMEMS_HORIZON_CONCURRENCY = 2;
const CDSE_LOOKBACK_MS = 30 * DAY_MS;
const CDSE_CATALOG_LIMIT = 100;

interface ProviderFailure {
  status: EnvironmentSyncStatus.CONFIGURATION_ERROR | EnvironmentSyncStatus.PROVIDER_UNAVAILABLE;
  errorCode: string;
  retryAfterMs: number | null;
}

interface CmemsGroup {
  values: CmemsEnvironmentValue[];
}

const LOCATIONFORECAST_COVERAGE: readonly {
  metric: EnvironmentMetric;
  present: (observation: MetLocationForecastObservation) => boolean;
}[] = [
  {
    metric: EnvironmentMetric.AIR_TEMPERATURE,
    present: (observation) => observation.airTemperature !== null,
  },
  {
    metric: EnvironmentMetric.WIND_SPEED,
    present: (observation) => observation.windSpeed !== null,
  },
  {
    metric: EnvironmentMetric.WIND_DIRECTION,
    present: (observation) => observation.windFromDirection !== null,
  },
  {
    metric: EnvironmentMetric.WIND_GUST,
    present: (observation) => observation.windGust !== null,
  },
  {
    metric: EnvironmentMetric.PRECIPITATION,
    present: (observation) => observation.precipitation?.periodHours === 1,
  },
  {
    metric: EnvironmentMetric.CLOUD_COVER,
    present: (observation) => observation.cloudAreaFraction !== null,
  },
  {
    metric: EnvironmentMetric.PRESSURE_MSL,
    present: (observation) => observation.airPressureAtSeaLevel !== null,
  },
  {
    metric: EnvironmentMetric.RELATIVE_HUMIDITY,
    present: (observation) => observation.relativeHumidity !== null,
  },
];

/**
 * Runs one already-claimed provider lease. All external I/O completes before
 * `EnvironmentSyncStore.complete` opens its short persistence transaction.
 */
@Injectable()
export class EnvironmentIngestionService {
  private readonly logger = new Logger(EnvironmentIngestionService.name);

  constructor(
    private readonly store: EnvironmentSyncStore,
    private readonly gate: EnvironmentMonitoringGate,
    private readonly providerConfiguration: EnvironmentProviderConfigurationService,
    private readonly locationForecast: MetLocationForecastService,
    private readonly frost: FrostObservationsService,
    private readonly cmems: CmemsRegionalService,
    private readonly cdse: CdseSentinelProvider,
    private readonly metrics: FarmDomainMetricsService,
  ) {}

  async processLease(lease: EnvironmentSyncLease): Promise<boolean> {
    this.gate.assertEnabled();
    const startedAt = new Date();
    let completion: EnvironmentSyncCompletion;
    try {
      completion = await this.fetchProvider(lease, startedAt);
      assertEnvironmentSyncCompletionContract(lease, completion);
    } catch (error) {
      const failure = this.classifyProviderFailure(error);
      const backoffMs = this.failureBackoffMs(lease.consecutiveFailures + 1, failure.retryAfterMs);
      completion = {
        status: failure.status,
        nextRunAt:
          failure.status === EnvironmentSyncStatus.CONFIGURATION_ERROR
            ? new Date(startedAt.getTime() + CONFIGURATION_RECHECK_MS)
            : new Date(startedAt.getTime() + backoffMs),
        errorCode: failure.errorCode,
        cursor: lease.cursor,
        successfulProviderResponse: false,
        coverage: [this.failureCoverage(lease.provider, failure, startedAt)],
        weather: [],
        marine: [],
        scenes: [],
      };
    }

    this.metrics.recordEnvironmentProviderCompletion({
      provider: lease.provider,
      status: completion.status,
      successfulProviderResponse: completion.successfulProviderResponse,
      scopeOutcomes: completion.coverage.map((scope) => scope.outcome),
    });
    const completed = await this.store.complete(lease, completion, new Date());
    if (!completed) {
      this.metrics.recordEnvironmentLeaseDiscard(lease.provider);
      this.logger.warn({
        message: 'Environmental provider result discarded after lease or location revision changed',
        provider: lease.provider,
      });
    }
    return completed;
  }

  private async fetchProvider(
    lease: EnvironmentSyncLease,
    now: Date,
  ): Promise<EnvironmentSyncCompletion> {
    switch (lease.provider) {
      case EnvironmentProvider.MET_LOCATIONFORECAST:
        return this.fetchLocationForecast(lease, now);
      case EnvironmentProvider.MET_FROST:
        return this.fetchFrost(lease, now);
      case EnvironmentProvider.CMEMS:
        return this.fetchCmems(lease, now);
      case EnvironmentProvider.CDSE_SENTINEL_2:
        return this.fetchCdse(lease, now);
    }
  }

  private async fetchLocationForecast(
    lease: EnvironmentSyncLease,
    now: Date,
  ): Promise<EnvironmentSyncCompletion> {
    const configuration = this.providerConfiguration.checkMetNorway(
      MetNorwayProvider.LOCATIONFORECAST,
    );
    if (!configuration.configured) {
      return this.configurationCompletion(
        EnvironmentProvider.MET_LOCATIONFORECAST,
        now,
        configuration.errorCode ?? 'MET_CONFIGURATION',
      );
    }

    const result = await this.locationForecast.fetchForecast({
      latitude: lease.latitude,
      longitude: lease.longitude,
      altitudeM: this.integerAltitude(lease.altitudeM),
    });
    if (result.status === 'NO_COVERAGE') {
      const status =
        result.reason === 'OUT_OF_COVERAGE'
          ? EnvironmentSyncStatus.OUT_OF_COVERAGE
          : EnvironmentSyncStatus.NO_DATA;
      return this.emptyProviderCompletion(
        EnvironmentProvider.MET_LOCATIONFORECAST,
        status,
        now,
        LOCATIONFORECAST_INTERVAL_MS,
      );
    }
    const weather = this.locationForecastRows(lease, result, now);
    return this.readyCompletion(now, LOCATIONFORECAST_INTERVAL_MS, {
      weather,
      marine: [],
      scenes: [],
      cursor: result.issuedAt,
      coverage: this.locationForecastCoverage(result),
    });
  }

  private async fetchFrost(
    lease: EnvironmentSyncLease,
    now: Date,
  ): Promise<EnvironmentSyncCompletion> {
    const configuration = this.providerConfiguration.checkMetNorway(MetNorwayProvider.FROST);
    if (!configuration.configured) {
      return this.configurationCompletion(
        EnvironmentProvider.MET_FROST,
        now,
        configuration.errorCode ?? 'FROST_CONFIGURATION',
      );
    }

    const result = await this.frost.fetchLast30Days({
      latitude: lease.latitude,
      longitude: lease.longitude,
    });
    if (result.status === 'NO_COVERAGE') {
      const status =
        result.reason === 'NO_STATION_WITH_REQUIRED_ELEMENTS'
          ? EnvironmentSyncStatus.OUT_OF_COVERAGE
          : EnvironmentSyncStatus.NO_DATA;
      return this.emptyProviderCompletion(
        EnvironmentProvider.MET_FROST,
        status,
        now,
        FROST_INTERVAL_MS,
      );
    }
    const weather = this.frostRows(lease, result);
    return this.readyCompletion(now, FROST_INTERVAL_MS, {
      weather,
      marine: [],
      scenes: [],
      cursor: result.requestedTo,
      coverage: this.frostCoverage(result),
    });
  }

  private async fetchCmems(
    lease: EnvironmentSyncLease,
    now: Date,
  ): Promise<EnvironmentSyncCompletion> {
    const horizons = Array.from(
      { length: CMEMS_HORIZON_COUNT },
      (_, index) => new Date(now.getTime() + index * CMEMS_HORIZON_STEP_MS),
    );
    const attempts = await runBounded(horizons, CMEMS_HORIZON_CONCURRENCY, (validAt) =>
      settleProviderWork(() =>
        this.cmems.fetchEnvironment({
          latitude: lease.latitude,
          longitude: lease.longitude,
          validAt,
          requestedDepthM: 0,
        }),
      ),
    );
    const results: CmemsRegionalResult[] = [];
    const coverage: EnvironmentSyncScopeCoverage[] = [];
    const unexpectedFailures: ProviderFailure[] = [];
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.status === 'fulfilled') {
        results.push(attempt.value);
        coverage.push(...attempt.value.coverage);
        continue;
      }
      const failure = this.classifyProviderFailure(attempt.reason);
      unexpectedFailures.push(failure);
      const validAt = horizons[index]!;
      coverage.push(
        ...CMEMS_ENVIRONMENT_METRICS.map((metric) => ({
          scopeKind: EnvironmentSyncScopeKind.METRIC_HORIZON,
          scopeKey: 'CMEMS:UNRESOLVED_HORIZON',
          metric,
          validFrom: validAt,
          validTo: validAt,
          outcome: this.coverageFailureOutcome(failure.status),
          errorCode: failure.errorCode,
          observationCount: 0,
        })),
      );
    }
    const coverageSummary = summarizeEnvironmentCoverage(coverage);
    const providerFailures = results.filter(
      (result): result is Extract<CmemsRegionalResult, { status: 'PROVIDER_FAILURE' }> =>
        result.status === 'PROVIDER_FAILURE',
    );
    if (coverageSummary.successful === 0) {
      const providerFailure = providerFailures[0];
      const fallbackFailure = unexpectedFailures[0];
      const configurationError = coverage.every(
        (scope) => scope.outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
      );
      const status = configurationError
        ? EnvironmentSyncStatus.CONFIGURATION_ERROR
        : EnvironmentSyncStatus.PROVIDER_UNAVAILABLE;
      const retryAfterMs = providerFailure?.retryAfterMs ?? fallbackFailure?.retryAfterMs ?? null;
      const nextRunAt =
        status === EnvironmentSyncStatus.CONFIGURATION_ERROR
          ? new Date(now.getTime() + CONFIGURATION_RECHECK_MS)
          : new Date(
              now.getTime() + this.failureBackoffMs(lease.consecutiveFailures + 1, retryAfterMs),
            );
      return {
        status,
        nextRunAt,
        errorCode:
          providerFailure?.errorCode ?? fallbackFailure?.errorCode ?? 'CMEMS_PROVIDER_UNAVAILABLE',
        cursor: lease.cursor,
        successfulProviderResponse: false,
        coverage,
        weather: [],
        marine: [],
        scenes: [],
      };
    }
    const available = results.filter(
      (result): result is Extract<CmemsRegionalResult, { status: 'AVAILABLE' | 'NO_DATA' }> =>
        result.status === 'AVAILABLE' || result.status === 'NO_DATA',
    );
    const values = this.deduplicateCmemsValues(available.flatMap((result) => result.values));
    const marine = this.cmemsRows(lease, values);
    if (coverageSummary.failed > 0) {
      return {
        status: EnvironmentSyncStatus.PARTIAL_FAILURE,
        nextRunAt: new Date(now.getTime() + CMEMS_INTERVAL_MS),
        errorCode: 'CMEMS_PARTIAL_FAILURE',
        cursor:
          marine.length === 0
            ? lease.cursor
            : marine
                .reduce(
                  (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
                  marine[0]!.observedAt,
                )
                .toISOString(),
        successfulProviderResponse: true,
        coverage,
        weather: [],
        marine,
        scenes: [],
      };
    }
    if (available.length === 0) {
      return this.emptyProviderCompletion(
        EnvironmentProvider.CMEMS,
        EnvironmentSyncStatus.OUT_OF_COVERAGE,
        now,
        OUT_OF_COVERAGE_INTERVAL_MS,
        coverage,
      );
    }

    if (marine.length === 0) {
      return this.emptyProviderCompletion(
        EnvironmentProvider.CMEMS,
        EnvironmentSyncStatus.NO_DATA,
        now,
        CMEMS_INTERVAL_MS,
        coverage,
      );
    }
    return this.readyCompletion(now, CMEMS_INTERVAL_MS, {
      weather: [],
      marine,
      scenes: [],
      coverage,
      cursor: marine
        .reduce(
          (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
          marine[0]!.observedAt,
        )
        .toISOString(),
    });
  }

  private async fetchCdse(
    lease: EnvironmentSyncLease,
    now: Date,
  ): Promise<EnvironmentSyncCompletion> {
    const result = await this.cdse.searchScenes({
      tenantId: lease.tenantId,
      siteId: lease.siteId,
      monitoringLocationRevision: lease.monitoringLocationRevision,
      geometry:
        lease.monitoringArea ??
        createSiteMonitoringCircle(lease.latitude, lease.longitude, lease.monitoringRadiusM),
      from: new Date(now.getTime() - CDSE_LOOKBACK_MS),
      to: now,
      limit: CDSE_CATALOG_LIMIT,
    });
    if (result.scenes.length === 0) {
      return this.emptyProviderCompletion(
        EnvironmentProvider.CDSE_SENTINEL_2,
        EnvironmentSyncStatus.NO_DATA,
        now,
        CDSE_INTERVAL_MS,
      );
    }

    const scenes = result.scenes.map((candidate) => this.cdseSceneRow(lease, candidate));
    const allOutside = result.scenes.every(
      (candidate) => candidate.coverageStatus === 'OUT_OF_COVERAGE',
    );
    const status = allOutside ? EnvironmentSyncStatus.OUT_OF_COVERAGE : EnvironmentSyncStatus.READY;
    return {
      status,
      nextRunAt: new Date(
        now.getTime() + (allOutside ? OUT_OF_COVERAGE_INTERVAL_MS : CDSE_INTERVAL_MS),
      ),
      errorCode: null,
      cursor: result.endCursor,
      successfulProviderResponse: true,
      coverage: [
        {
          scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
          scopeKey: 'CDSE:SENTINEL_2_L2A',
          metric: null,
          validFrom: new Date(now.getTime() - CDSE_LOOKBACK_MS),
          validTo: now,
          outcome: allOutside
            ? EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE
            : EnvironmentSyncScopeOutcome.AVAILABLE,
          errorCode: null,
          observationCount: result.scenes.length,
        },
      ],
      weather: [],
      marine: [],
      scenes,
    };
  }

  private locationForecastRows(
    lease: EnvironmentSyncLease,
    result: MetLocationForecastAvailable,
    now: Date,
  ): CanonicalWeatherInsert[] {
    const issuedAt = new Date(result.issuedAt);
    const fetchedAt = new Date(result.fetchedAt);
    const byValidAt = new Map(
      result.forecast.map((observation) => [observation.validAt, observation]),
    );
    byValidAt.set(result.current.validAt, result.current);

    return [...byValidAt.values()]
      .sort((left, right) => left.validAt.localeCompare(right.validAt))
      .map((observation) => {
        const observedAt = new Date(observation.validAt);
        return {
          tenantId: lease.tenantId,
          siteId: lease.siteId,
          observedAt,
          dataType:
            observedAt.getTime() > now.getTime()
              ? WeatherDataType.FORECAST
              : WeatherDataType.HISTORICAL,
          provider: EnvironmentProvider.MET_LOCATIONFORECAST,
          productId: 'locationforecast-2.0',
          datasetId: 'compact',
          sourceRunKey: `met-locationforecast:${result.issuedAt}`,
          issuedAt,
          semanticClass: EnvironmentSemanticClass.FORECAST,
          qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
          stationId: null,
          stationDistanceKm: null,
          horizontalResolutionM: null,
          monitoringLocationRevision: lease.monitoringLocationRevision,
          temperature: this.metValue(observation.airTemperature, ['celsius']),
          windSpeed: this.metValue(observation.windSpeed, ['m/s']),
          windDirection: this.metValue(observation.windFromDirection, ['degrees']),
          windGusts: this.metValue(observation.windGust, ['m/s']),
          precipitation:
            observation.precipitation?.periodHours === 1
              ? this.metValue(observation.precipitation.amount, ['mm'])
              : null,
          cloudCover: this.metValue(observation.cloudAreaFraction, ['%']),
          pressureMsl: this.metValue(observation.airPressureAtSeaLevel, ['hPa']),
          relativeHumidity: this.metValue(observation.relativeHumidity, ['%']),
          fetchedAt,
        };
      });
  }

  private frostRows(
    lease: EnvironmentSyncLease,
    result: FrostHistoryAvailable,
  ): CanonicalWeatherInsert[] {
    const groups = new Map<string, FrostObservation[]>();
    for (const observation of result.observations) {
      const group = groups.get(observation.referenceTime) ?? [];
      if (group.some((candidate) => candidate.elementId === observation.elementId)) {
        throw new MetNorwayProviderError({
          provider: MetNorwayProvider.FROST,
          code: MetNorwayProviderErrorCode.SCHEMA,
          message: 'Frost returned duplicate elements for a canonical instant',
          retryable: false,
        });
      }
      group.push(observation);
      groups.set(observation.referenceTime, group);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([referenceTime, observations]) => {
        const values = new Map(
          observations.map((observation) => [observation.elementId, observation]),
        );
        const fetchedAt = new Date(result.fetchedAt);
        return {
          tenantId: lease.tenantId,
          siteId: lease.siteId,
          observedAt: new Date(referenceTime),
          dataType: WeatherDataType.HISTORICAL,
          provider: EnvironmentProvider.MET_FROST,
          productId: 'frost-observations-v0',
          datasetId: `${result.station.id}:timeseries-0`,
          sourceRunKey: frostSourceRunKey(result.station.id, referenceTime, observations),
          issuedAt: null,
          semanticClass: EnvironmentSemanticClass.OBSERVATION,
          qualityStatus: observations.every((observation) =>
            [FrostQualityStatus.CONTROLLED_OK, FrostQualityStatus.CONTROLLED_CORRECTED].includes(
              observation.qualityStatus,
            ),
          )
            ? EnvironmentQualityStatus.VALID
            : EnvironmentQualityStatus.PROVISIONAL,
          stationId: result.station.id,
          stationDistanceKm: result.station.distanceKm,
          horizontalResolutionM: null,
          monitoringLocationRevision: lease.monitoringLocationRevision,
          temperature: this.frostValue(values.get(FrostElementId.AIR_TEMPERATURE), ['degC']),
          windSpeed: this.frostValue(values.get(FrostElementId.WIND_SPEED), ['m/s']),
          windDirection: this.frostValue(values.get(FrostElementId.WIND_FROM_DIRECTION), [
            'degrees',
          ]),
          windGusts: null,
          precipitation: this.frostValue(values.get(FrostElementId.HOURLY_PRECIPITATION), ['mm']),
          cloudCover: null,
          pressureMsl: null,
          relativeHumidity: this.frostValue(values.get(FrostElementId.RELATIVE_HUMIDITY), ['%']),
          fetchedAt,
        };
      });
  }

  private deduplicateCmemsValues(values: CmemsEnvironmentValue[]): CmemsEnvironmentValue[] {
    const unique = new Map<string, CmemsEnvironmentValue>();
    for (const value of values) {
      const key = [
        value.productId,
        value.datasetId,
        value.variableId,
        value.metric,
        value.validAt,
        value.modelDepthM ?? 'surface',
      ].join('|');
      unique.set(key, value);
    }
    return [...unique.values()];
  }

  private cmemsRows(
    lease: EnvironmentSyncLease,
    values: CmemsEnvironmentValue[],
  ): CanonicalMarineInsert[] {
    const groups = new Map<string, CmemsGroup>();
    for (const value of values) {
      if (value.value === null) continue;
      const key = [
        value.productId,
        value.datasetId,
        value.validAt,
        value.requestedDepthM ?? 'none',
        value.modelDepthM ?? 'none',
        value.horizontalResolutionM,
        value.semanticClass,
      ].join('|');
      const group = groups.get(key) ?? { values: [] };
      if (group.values.some((candidate) => candidate.metric === value.metric)) {
        throw new CmemsProviderError({
          code: CmemsProviderErrorCode.SCHEMA,
          message: 'CMEMS returned duplicate metrics for a canonical dataset instant',
          retryable: false,
        });
      }
      group.values.push(value);
      groups.set(key, group);
    }

    return [...groups.values()]
      .map((group) => this.cmemsGroupRow(lease, group.values))
      .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  }

  private cmemsGroupRow(
    lease: EnvironmentSyncLease,
    values: CmemsEnvironmentValue[],
  ): CanonicalMarineInsert {
    const first = values[0]!;
    const metrics = new Map(values.map((value) => [value.metric, value.value]));
    const variableMappings = values
      .map((value) => `${value.metric}=${value.sourceVariableIds.join('+')}`)
      .sort();
    const sourceVersion = createHash('sha256')
      .update(
        JSON.stringify(
          values
            .map((value) => ({
              metric: value.metric,
              value: value.value,
              unit: value.unit,
              productId: value.productId,
              datasetId: value.datasetId,
              variableId: value.variableId,
              sourceVariableIds: value.sourceVariableIds,
              validAt: value.validAt,
              productMetadataUpdatedAt: value.productMetadataUpdatedAt,
              capabilityUpdatedAt: value.capabilityUpdatedAt,
              dataUpdatedAt: value.dataUpdatedAt,
              requestedDepthM: value.requestedDepthM,
              modelDepthM: value.modelDepthM,
              horizontalResolutionM: value.horizontalResolutionM,
              gridDistanceM: value.gridDistanceM,
            }))
            .sort((left, right) => {
              const metricOrder = left.metric.localeCompare(right.metric);
              return metricOrder || left.variableId.localeCompare(right.variableId);
            }),
        ),
      )
      .digest('hex');
    const fetchedAt = latestDate(values.map((value) => value.fetchedAt));
    const gridDistances = values
      .map((value) => value.gridDistanceM)
      .filter((value): value is number => value !== null);
    const observedAt = new Date(first.validAt);
    return {
      tenantId: lease.tenantId,
      siteId: lease.siteId,
      observedAt,
      dataType:
        first.semanticClass === EnvironmentSemanticClass.FORECAST
          ? WeatherDataType.FORECAST
          : WeatherDataType.HISTORICAL,
      provider: EnvironmentProvider.CMEMS,
      productId: first.productId,
      datasetId: first.datasetId,
      variableSetId: variableMappings.join(','),
      sourceRunKey: `cmems:${sourceVersion}`,
      // WMTS exposes data/metadata update times, not the model run issue time.
      // Keep those timestamps in sourceVersion rather than relabelling them.
      issuedAt: null,
      semanticClass: first.semanticClass,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      waveHeight: metrics.get(EnvironmentMetric.WAVE_HEIGHT) ?? null,
      waveDirection: metrics.get(EnvironmentMetric.WAVE_DIRECTION) ?? null,
      wavePeriod: metrics.get(EnvironmentMetric.WAVE_PERIOD) ?? null,
      oceanCurrentVelocity: metrics.get(EnvironmentMetric.CURRENT_SPEED) ?? null,
      oceanCurrentDirection: metrics.get(EnvironmentMetric.CURRENT_DIRECTION) ?? null,
      seaSurfaceTemperature: metrics.get(EnvironmentMetric.SEA_TEMPERATURE) ?? null,
      salinity: metrics.get(EnvironmentMetric.SALINITY) ?? null,
      dissolvedOxygen: metrics.get(EnvironmentMetric.DISSOLVED_OXYGEN) ?? null,
      modelChlorophyll: metrics.get(EnvironmentMetric.MODEL_CHLOROPHYLL) ?? null,
      requestedDepthM: first.requestedDepthM,
      modelDepthM: first.modelDepthM,
      horizontalResolutionM: first.horizontalResolutionM,
      gridCellDistanceM: gridDistances.length > 0 ? Math.max(...gridDistances) : null,
      coveragePercent: null,
      monitoringLocationRevision: lease.monitoringLocationRevision,
      fetchedAt,
    };
  }

  private cdseSceneRow(
    lease: EnvironmentSyncLease,
    candidate: CdseSceneObservationCandidate,
  ): CanonicalSatelliteSceneInsert {
    if (
      candidate.tenantId !== lease.tenantId ||
      candidate.siteId !== lease.siteId ||
      candidate.monitoringLocationRevision !== lease.monitoringLocationRevision ||
      candidate.provider !== EnvironmentProvider.CDSE_SENTINEL_2
    ) {
      throw new CdseProviderError({
        code: CdseProviderErrorCode.SCENE_MISMATCH,
        message: 'CDSE candidate does not match the claimed site revision',
        retryable: false,
      });
    }
    return {
      tenantId: candidate.tenantId,
      siteId: candidate.siteId,
      sceneId: candidate.sceneId,
      collection: candidate.collection,
      provider: candidate.provider,
      productId: candidate.productId,
      datasetId: candidate.datasetId,
      acquiredAt: new Date(candidate.acquiredAt),
      cloudCoverPercent: candidate.cloudCoverPercent,
      coveragePercent: candidate.coveragePercent,
      coverageStatus: candidate.coverageStatus,
      coverageMethod: candidate.coverageMethod,
      coverageSampleCount: candidate.coverageSampleCount,
      qualityStatus: candidate.qualityStatus,
      monitoringLocationRevision: candidate.monitoringLocationRevision,
      fetchedAt: new Date(candidate.fetchedAt),
    };
  }

  private metValue(
    measurement: MetLocationForecastMeasurement | null,
    expectedUnits: readonly string[],
  ): number | null {
    if (!measurement) return null;
    if (!expectedUnits.includes(measurement.unit)) {
      throw new MetNorwayProviderError({
        provider: MetNorwayProvider.LOCATIONFORECAST,
        code: MetNorwayProviderErrorCode.SCHEMA,
        message: 'Locationforecast returned an unexpected measurement unit',
        retryable: false,
      });
    }
    return measurement.value;
  }

  private frostValue(
    observation: FrostObservation | undefined,
    expectedUnits: readonly string[],
  ): number | null {
    if (!observation) return null;
    if (!expectedUnits.includes(observation.unit)) {
      throw new MetNorwayProviderError({
        provider: MetNorwayProvider.FROST,
        code: MetNorwayProviderErrorCode.SCHEMA,
        message: 'Frost returned an unexpected observation unit',
        retryable: false,
      });
    }
    return observation.value;
  }

  private integerAltitude(altitudeM: number | null): number | undefined {
    if (altitudeM === null || !Number.isFinite(altitudeM)) return undefined;
    const rounded = Math.round(altitudeM);
    return rounded >= -500 && rounded <= 9_000 ? rounded : undefined;
  }

  private readyCompletion(
    now: Date,
    intervalMs: number,
    rows: {
      weather: readonly CanonicalWeatherInsert[];
      marine: readonly CanonicalMarineInsert[];
      scenes: readonly CanonicalSatelliteSceneInsert[];
      cursor: string | null;
      coverage: readonly EnvironmentSyncScopeCoverage[];
    },
  ): EnvironmentSyncCompletion {
    return {
      status: EnvironmentSyncStatus.READY,
      nextRunAt: new Date(now.getTime() + intervalMs),
      errorCode: null,
      cursor: rows.cursor,
      successfulProviderResponse: true,
      coverage: rows.coverage,
      weather: rows.weather,
      marine: rows.marine,
      scenes: rows.scenes,
    };
  }

  private emptyProviderCompletion(
    provider: EnvironmentProvider,
    status: EnvironmentSyncStatus.NO_DATA | EnvironmentSyncStatus.OUT_OF_COVERAGE,
    now: Date,
    normalIntervalMs: number,
    coverage: readonly EnvironmentSyncScopeCoverage[] = [
      {
        scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
        scopeKey: `${provider}:PROVIDER_RUN`,
        metric: null,
        validFrom: null,
        validTo: null,
        outcome:
          status === EnvironmentSyncStatus.OUT_OF_COVERAGE
            ? EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE
            : EnvironmentSyncScopeOutcome.NO_DATA,
        errorCode: null,
        observationCount: 0,
      },
    ],
  ): EnvironmentSyncCompletion {
    return {
      status,
      nextRunAt: new Date(
        now.getTime() +
          (status === EnvironmentSyncStatus.OUT_OF_COVERAGE
            ? OUT_OF_COVERAGE_INTERVAL_MS
            : normalIntervalMs),
      ),
      errorCode: null,
      cursor: null,
      successfulProviderResponse: true,
      coverage,
      weather: [],
      marine: [],
      scenes: [],
    };
  }

  private configurationCompletion(
    provider: EnvironmentProvider,
    now: Date,
    errorCode: string,
  ): EnvironmentSyncCompletion {
    return {
      status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
      nextRunAt: new Date(now.getTime() + CONFIGURATION_RECHECK_MS),
      errorCode,
      cursor: null,
      successfulProviderResponse: false,
      coverage: [
        {
          scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
          scopeKey: `${provider}:PROVIDER_RUN`,
          metric: null,
          validFrom: null,
          validTo: null,
          outcome: EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
          errorCode,
          observationCount: 0,
        },
      ],
      weather: [],
      marine: [],
      scenes: [],
    };
  }

  private locationForecastCoverage(
    result: MetLocationForecastAvailable,
  ): EnvironmentSyncScopeCoverage[] {
    const byValidAt = new Map(
      result.forecast.map((observation) => [observation.validAt, observation]),
    );
    byValidAt.set(result.current.validAt, result.current);
    const observations = [...byValidAt.values()];
    const validTimes = observations.map((observation) => new Date(observation.validAt));
    const validFrom = validTimes.reduce(
      (earliest, value) => (value < earliest ? value : earliest),
      validTimes[0]!,
    );
    const validTo = validTimes.reduce(
      (latest, value) => (value > latest ? value : latest),
      validTimes[0]!,
    );
    return LOCATIONFORECAST_COVERAGE.map((definition) => {
      const observationCount = observations.filter(definition.present).length;
      return {
        scopeKind: EnvironmentSyncScopeKind.METRIC_SUMMARY,
        scopeKey: `MET_LOCATIONFORECAST:${definition.metric}`,
        metric: definition.metric,
        validFrom,
        validTo,
        outcome:
          observationCount > 0
            ? EnvironmentSyncScopeOutcome.AVAILABLE
            : EnvironmentSyncScopeOutcome.NO_DATA,
        errorCode: null,
        observationCount,
      };
    });
  }

  private frostCoverage(result: FrostHistoryAvailable): EnvironmentSyncScopeCoverage[] {
    const coverage: EnvironmentSyncScopeCoverage[] = result.elementCoverage.map((element) => ({
      scopeKind: EnvironmentSyncScopeKind.METRIC_SUMMARY,
      scopeKey: `MET_FROST:${element.elementId}`,
      metric: this.frostMetric(element.elementId),
      validFrom: new Date(result.requestedFrom),
      validTo: new Date(result.requestedTo),
      outcome:
        element.status === 'AVAILABLE'
          ? EnvironmentSyncScopeOutcome.AVAILABLE
          : EnvironmentSyncScopeOutcome.NO_DATA,
      errorCode: null,
      observationCount: element.observationCount,
    }));
    for (const interval of result.missingIntervals) {
      coverage.push({
        scopeKind: EnvironmentSyncScopeKind.METRIC_INTERVAL,
        scopeKey: `MET_FROST:${interval.elementId}:${interval.from}:${interval.to}`,
        metric: this.frostMetric(interval.elementId),
        validFrom: new Date(interval.from),
        validTo: new Date(interval.to),
        outcome: EnvironmentSyncScopeOutcome.NO_DATA,
        errorCode: null,
        observationCount: 0,
      });
    }
    return coverage;
  }

  private frostMetric(elementId: FrostElementId): EnvironmentMetric | null {
    switch (elementId) {
      case FrostElementId.AIR_TEMPERATURE:
        return EnvironmentMetric.AIR_TEMPERATURE;
      case FrostElementId.WIND_SPEED:
        return EnvironmentMetric.WIND_SPEED;
      case FrostElementId.WIND_FROM_DIRECTION:
        return EnvironmentMetric.WIND_DIRECTION;
      case FrostElementId.RELATIVE_HUMIDITY:
        return EnvironmentMetric.RELATIVE_HUMIDITY;
      case FrostElementId.HOURLY_PRECIPITATION:
        return EnvironmentMetric.PRECIPITATION;
      case FrostElementId.SURFACE_AIR_PRESSURE:
        return null;
    }
  }

  private failureCoverage(
    provider: EnvironmentProvider,
    failure: ProviderFailure,
    attemptedAt: Date,
  ): EnvironmentSyncScopeCoverage {
    return {
      scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
      scopeKey: `${provider}:PROVIDER_RUN`,
      metric: null,
      validFrom: attemptedAt,
      validTo: attemptedAt,
      outcome: this.coverageFailureOutcome(failure.status),
      errorCode: failure.errorCode,
      observationCount: 0,
    };
  }

  private coverageFailureOutcome(
    status: EnvironmentSyncStatus.CONFIGURATION_ERROR | EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
  ):
    | EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
    | EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE {
    return status === EnvironmentSyncStatus.CONFIGURATION_ERROR
      ? EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
      : EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE;
  }

  private classifyProviderFailure(error: unknown): ProviderFailure {
    if (error instanceof EnvironmentCompletionContractError) {
      return {
        status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
        errorCode: 'PROVIDER_DATA_CONTRACT',
        retryAfterMs: null,
      };
    }
    if (error instanceof MetNorwayProviderError) {
      const configuration = [
        MetNorwayProviderErrorCode.CONFIGURATION,
        MetNorwayProviderErrorCode.CLIENT_REQUEST,
      ].includes(error.code);
      return {
        status: configuration
          ? EnvironmentSyncStatus.CONFIGURATION_ERROR
          : EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
        errorCode: `MET_${error.code}`,
        retryAfterMs:
          error.retryAfterSeconds === undefined ? null : error.retryAfterSeconds * 1_000,
      };
    }
    if (error instanceof CmemsProviderError) {
      const configuration = [
        CmemsProviderErrorCode.CONFIGURATION,
        CmemsProviderErrorCode.CLIENT_REQUEST,
      ].includes(error.code);
      return {
        status: configuration
          ? EnvironmentSyncStatus.CONFIGURATION_ERROR
          : EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
        errorCode: `CMEMS_${error.code}`,
        retryAfterMs: error.retryAfterMs ?? null,
      };
    }
    if (error instanceof CdseProviderError) {
      const configuration = [
        CdseProviderErrorCode.CONFIGURATION,
        CdseProviderErrorCode.AUTHENTICATION,
        CdseProviderErrorCode.CLIENT_REQUEST,
      ].includes(error.code);
      return {
        status: configuration
          ? EnvironmentSyncStatus.CONFIGURATION_ERROR
          : EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
        errorCode: `CDSE_${error.code}`,
        retryAfterMs: error.retryAfterMs ?? null,
      };
    }
    return {
      status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
      errorCode: 'PROVIDER_UNEXPECTED_ERROR',
      retryAfterMs: null,
    };
  }

  private failureBackoffMs(failureCount: number, retryAfterMs: number | null): number {
    const exponent = Math.min(Math.max(failureCount - 1, 0), 8);
    const exponential = Math.min(MAX_FAILURE_BACKOFF_MS, BASE_FAILURE_BACKOFF_MS * 2 ** exponent);
    if (retryAfterMs === null || !Number.isFinite(retryAfterMs)) {
      return exponential;
    }
    return Math.min(MAX_FAILURE_BACKOFF_MS, Math.max(exponential, retryAfterMs));
  }
}

function latestDate(values: readonly string[]): Date {
  if (values.length === 0) {
    throw new Error('Cannot select a latest date from an empty provider value set');
  }
  return new Date(
    values.reduce((latest, value) =>
      new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
    ),
  );
}

function frostSourceRunKey(
  stationId: string,
  referenceTime: string,
  observations: readonly FrostObservation[],
): string {
  const canonicalMeasurements = observations
    .map((observation) => ({
      elementId: observation.elementId,
      value: observation.value,
      unit: observation.unit,
      qualityCode: observation.qualityCode,
      qualityStatus: observation.qualityStatus,
      timeOffset: observation.timeOffset,
      timeResolution: observation.timeResolution,
    }))
    .sort((left, right) => left.elementId.localeCompare(right.elementId));
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        stationId,
        referenceTime,
        measurements: canonicalMeasurements,
      }),
    )
    .digest('hex');
  return `frost:${digest}`;
}

export async function runBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('provider concurrency must be a positive integer');
  }
  const results: R[] = new Array(values.length);
  const queue = values.entries();
  const state: { failure: PromiseRejectedResult | null } = { failure: null };
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async (): Promise<void> => {
      while (state.failure === null) {
        const next = queue.next();
        if (next.done) return;
        const [index, value] = next.value;
        try {
          results[index] = await work(value);
        } catch (reason) {
          if (state.failure === null) {
            state.failure = { status: 'rejected', reason };
          }
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (state.failure !== null) {
    throw state.failure.reason;
  }
  return results;
}

async function settleProviderWork<T>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await work() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
