import { runInTenantRead } from '@aquaculture/backend-common/database';
import { buildCursorResponse, normaliseCursorInput } from '@aquaculture/backend-common/pagination';
import { SiteAuthorizationService, SiteScopeCaller } from '@aquaculture/backend-common/security';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, In, MoreThanOrEqual, QueryRunner } from 'typeorm';

import {
  ENVIRONMENT_LAYER_CATALOG,
  MarineLayerDefinition,
} from '../../marine-data/marine-layer-catalog';
import { Site, SiteType } from '../../site/entities/site.entity';
import { EnvironmentScenesInput, SiteEnvironmentHistoryInput } from '../dto/environment.input';
import {
  EnvironmentLayerResponse,
  EnvironmentCoverageSummaryResponse,
  EnvironmentSceneCursorConnection,
  EnvironmentSceneResponse,
  EnvironmentValueResponse,
  SiteEnvironmentValuesResponse,
} from '../dto/environment.response';
import {
  CANONICAL_MARINE_PROVIDERS,
  CANONICAL_WEATHER_PROVIDERS,
  EnvironmentAvailabilityStatus,
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncStatus,
  EnvironmentSyncScopeOutcome,
  SatelliteCoverageStatus,
} from '../entities/environment-observation.types';
import { EnvironmentMetricSyncOutcome } from '../entities/environment-metric-sync-outcome.entity';
import { MarineObservation } from '../entities/marine-observation.entity';
import { SatelliteSceneObservation } from '../entities/satellite-scene-observation.entity';
import { SiteEnvironmentSyncState } from '../entities/site-environment-sync-state.entity';
import { WeatherDataType, WeatherObservation } from '../entities/weather-observation.entity';
import { EnvironmentMonitoringGate } from './environment-monitoring-gate.service';
import { selectSatelliteCoverageAssessment } from './satellite-coverage-assessment-selection';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_HISTORY_MS = 30 * DAY_MS;
const OBSERVATION_RETENTION_MS = 45 * DAY_MS;
const CLIENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;

interface MetricDefinition<Row> {
  readonly metric: EnvironmentMetric;
  readonly unit: string;
  readonly variableId: string;
  readonly read: (row: Row) => number | null | undefined;
  readonly staleAfterMs: number;
}

interface LatestObservationSelection {
  tenantId: string;
  siteId: string;
  monitoringLocationRevision: number;
  from: Date;
  to: Date | null;
  dataType: WeatherDataType | null;
  metrics: readonly EnvironmentMetric[];
  current: boolean;
}

interface ObservationIdentity {
  id: string;
}

interface AvailabilityRange {
  readonly from: Date;
  readonly to: Date;
  readonly freshnessAt: Date;
  readonly staleAfterMs: number;
}

type CanonicalWeatherObservation = WeatherObservation & {
  provider: EnvironmentProvider.MET_LOCATIONFORECAST | EnvironmentProvider.MET_FROST;
  productId: string;
  datasetId: string;
  sourceRunKey: string;
  semanticClass: EnvironmentSemanticClass;
  qualityStatus: EnvironmentQualityStatus;
};

type CanonicalMarineObservation = MarineObservation & {
  provider: EnvironmentProvider.CMEMS;
  productId: string;
  datasetId: string;
  variableSetId: string;
  sourceRunKey: string;
  semanticClass: EnvironmentSemanticClass.ANALYSIS | EnvironmentSemanticClass.FORECAST;
  qualityStatus: EnvironmentQualityStatus;
};

const WEATHER_METRICS: readonly MetricDefinition<WeatherObservation>[] = [
  {
    metric: EnvironmentMetric.AIR_TEMPERATURE,
    unit: '°C',
    variableId: 'air_temperature',
    read: (row) => row.temperature,
    staleAfterMs: 6 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.WIND_SPEED,
    unit: 'm/s',
    variableId: 'wind_speed',
    read: (row) => row.windSpeed,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.WIND_DIRECTION,
    unit: '°',
    variableId: 'wind_from_direction',
    read: (row) => row.windDirection,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.WIND_GUST,
    unit: 'm/s',
    variableId: 'wind_speed_of_gust',
    read: (row) => row.windGusts,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.PRECIPITATION,
    unit: 'mm',
    variableId: 'next_1_hours.precipitation_amount',
    read: (row) => row.precipitation,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.CLOUD_COVER,
    unit: '%',
    variableId: 'cloud_area_fraction',
    read: (row) => row.cloudCover,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.PRESSURE_MSL,
    unit: 'hPa',
    variableId: 'air_pressure_at_sea_level',
    read: (row) => row.pressureMsl,
    staleAfterMs: 6 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.RELATIVE_HUMIDITY,
    unit: '%',
    variableId: 'relative_humidity',
    read: (row) => row.relativeHumidity,
    staleAfterMs: 6 * 60 * 60 * 1_000,
  },
] as const;

const MARINE_METRICS: readonly MetricDefinition<MarineObservation>[] = [
  {
    metric: EnvironmentMetric.WAVE_HEIGHT,
    unit: 'm',
    variableId: 'VHM0',
    read: (row) => row.waveHeight,
    staleAfterMs: 12 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.WAVE_DIRECTION,
    unit: '°',
    variableId: 'VMDR',
    read: (row) => row.waveDirection,
    staleAfterMs: 12 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.WAVE_PERIOD,
    unit: 's',
    variableId: 'VTM02',
    read: (row) => row.wavePeriod,
    staleAfterMs: 12 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.CURRENT_SPEED,
    unit: 'm/s',
    variableId: 'uo,vo',
    read: (row) => row.oceanCurrentVelocity,
    staleAfterMs: 12 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.CURRENT_DIRECTION,
    unit: '°',
    variableId: 'uo,vo',
    read: (row) => row.oceanCurrentDirection,
    staleAfterMs: 12 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.SEA_TEMPERATURE,
    unit: '°C',
    variableId: 'thetao',
    read: (row) => row.seaSurfaceTemperature,
    staleAfterMs: 36 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.SALINITY,
    unit: 'PSU',
    variableId: 'so',
    read: (row) => row.salinity,
    staleAfterMs: 36 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.DISSOLVED_OXYGEN,
    unit: 'mmol/m³',
    variableId: 'o2',
    read: (row) => row.dissolvedOxygen,
    staleAfterMs: 48 * 60 * 60 * 1_000,
  },
  {
    metric: EnvironmentMetric.MODEL_CHLOROPHYLL,
    unit: 'mg/m³',
    variableId: 'chl',
    read: (row) => row.modelChlorophyll,
    staleAfterMs: 48 * 60 * 60 * 1_000,
  },
] as const;

const METRIC_SET = new Set<EnvironmentMetric>([
  ...WEATHER_METRICS.map(({ metric }) => metric),
  ...MARINE_METRICS.map(({ metric }) => metric),
]);

function isPresent(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

function isCanonicalWeatherProvider(
  provider: EnvironmentProvider | null | undefined,
): provider is EnvironmentProvider.MET_LOCATIONFORECAST | EnvironmentProvider.MET_FROST {
  return (
    provider === EnvironmentProvider.MET_LOCATIONFORECAST ||
    provider === EnvironmentProvider.MET_FROST
  );
}

function assertCanonicalWeatherObservation(
  row: WeatherObservation,
): asserts row is CanonicalWeatherObservation {
  if (
    !isCanonicalWeatherProvider(row.provider) ||
    typeof row.productId !== 'string' ||
    row.productId.length === 0 ||
    typeof row.datasetId !== 'string' ||
    row.datasetId.length === 0 ||
    typeof row.sourceRunKey !== 'string' ||
    row.sourceRunKey.length === 0 ||
    (row.provider === EnvironmentProvider.MET_FROST &&
      row.semanticClass !== EnvironmentSemanticClass.OBSERVATION) ||
    (row.provider === EnvironmentProvider.MET_LOCATIONFORECAST &&
      row.semanticClass !== EnvironmentSemanticClass.FORECAST) ||
    (row.qualityStatus !== EnvironmentQualityStatus.VALID &&
      row.qualityStatus !== EnvironmentQualityStatus.PROVISIONAL)
  ) {
    throw new Error('Canonical weather observation failed provenance validation');
  }
}

function canonicalWeatherObservations(
  rows: readonly WeatherObservation[],
): CanonicalWeatherObservation[] {
  return rows
    .filter((row) => isCanonicalWeatherProvider(row.provider))
    .map((row) => {
      assertCanonicalWeatherObservation(row);
      return row;
    });
}

function assertCanonicalMarineObservation(
  row: MarineObservation,
): asserts row is CanonicalMarineObservation {
  if (
    row.provider !== EnvironmentProvider.CMEMS ||
    typeof row.productId !== 'string' ||
    row.productId.length === 0 ||
    typeof row.datasetId !== 'string' ||
    row.datasetId.length === 0 ||
    typeof row.variableSetId !== 'string' ||
    row.variableSetId.length === 0 ||
    typeof row.sourceRunKey !== 'string' ||
    row.sourceRunKey.length === 0 ||
    (row.semanticClass !== EnvironmentSemanticClass.ANALYSIS &&
      row.semanticClass !== EnvironmentSemanticClass.FORECAST) ||
    row.qualityStatus !== EnvironmentQualityStatus.PROVISIONAL
  ) {
    throw new Error('Canonical marine observation failed provenance validation');
  }
}

function canonicalMarineObservations(
  rows: readonly MarineObservation[],
): CanonicalMarineObservation[] {
  return rows
    .filter((row) => row.provider === EnvironmentProvider.CMEMS)
    .map((row) => {
      assertCanonicalMarineObservation(row);
      return row;
    });
}

function compareDateDescending(
  left: Date | null | undefined,
  right: Date | null | undefined,
): number {
  const leftTime = left?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightTime = right?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftTime === rightTime) return 0;
  return leftTime > rightTime ? -1 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareWeatherVersion(
  left: CanonicalWeatherObservation,
  right: CanonicalWeatherObservation,
): number {
  const leftPriority = left.provider === EnvironmentProvider.MET_FROST ? 0 : 1;
  const rightPriority = right.provider === EnvironmentProvider.MET_FROST ? 0 : 1;
  return (
    leftPriority - rightPriority ||
    compareDateDescending(left.issuedAt, right.issuedAt) ||
    compareDateDescending(left.fetchedAt, right.fetchedAt) ||
    compareText(left.provider, right.provider) ||
    compareText(left.productId, right.productId) ||
    compareText(left.datasetId, right.datasetId) ||
    compareText(left.sourceRunKey, right.sourceRunKey)
  );
}

function compareMarineVersion(
  left: CanonicalMarineObservation,
  right: CanonicalMarineObservation,
): number {
  return (
    compareDateDescending(left.issuedAt, right.issuedAt) ||
    compareDateDescending(left.fetchedAt, right.fetchedAt) ||
    compareText(left.provider, right.provider) ||
    compareText(left.productId, right.productId) ||
    compareText(left.datasetId, right.datasetId) ||
    compareText(left.sourceRunKey, right.sourceRunKey)
  );
}

function orderCanonicalWeatherObservations(
  rows: readonly WeatherObservation[],
  newestFirst: boolean,
): CanonicalWeatherObservation[] {
  return canonicalWeatherObservations(rows).sort((left, right) => {
    const validAtOrder = compareDateDescending(left.observedAt, right.observedAt);
    return (newestFirst ? validAtOrder : -validAtOrder) || compareWeatherVersion(left, right);
  });
}

function orderCanonicalMarineObservations(
  rows: readonly MarineObservation[],
  newestFirst: boolean,
): CanonicalMarineObservation[] {
  return canonicalMarineObservations(rows).sort((left, right) => {
    const validAtOrder = compareDateDescending(left.observedAt, right.observedAt);
    return (newestFirst ? validAtOrder : -validAtOrder) || compareMarineVersion(left, right);
  });
}

function qualityForCurrent(
  persisted: EnvironmentQualityStatus,
  validAt: Date,
  issuedAt: Date | null | undefined,
  fetchedAt: Date,
  staleAfterMs: number,
  now: Date,
): EnvironmentQualityStatus {
  if (now.getTime() - freshnessReference(validAt, issuedAt, fetchedAt).getTime() > staleAfterMs) {
    return EnvironmentQualityStatus.STALE;
  }
  return persisted;
}

function freshnessReference(
  validAt: Date,
  issuedAt: Date | null | undefined,
  fetchedAt: Date,
): Date {
  return new Date(
    Math.min(validAt.getTime(), (issuedAt ?? fetchedAt).getTime(), fetchedAt.getTime()),
  );
}

function latestDate(values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

@Injectable()
export class EnvironmentReadService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly siteAuthorization: SiteAuthorizationService,
    private readonly monitoringGate: EnvironmentMonitoringGate,
  ) {}

  async current(
    tenantId: string,
    caller: SiteScopeCaller,
    siteId: string,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    this.assertSiteAccess(caller, siteId);
    const now = new Date();
    const from = new Date(now.getTime() - OBSERVATION_RETENTION_MS);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await this.requireSite(queryRunner.manager, tenantId, siteId);
      const [weatherRows, marineRows] = await Promise.all([
        this.latestWeatherRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from,
          to: now,
          dataType: null,
          metrics: WEATHER_METRICS.map(({ metric }) => metric),
          current: true,
        }),
        this.latestMarineRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from,
          to: now,
          dataType: null,
          metrics: MARINE_METRICS.map(({ metric }) => metric),
          current: true,
        }),
      ]);

      const values = this.latestMetricValues(weatherRows, marineRows, now);
      return { siteId, values };
    });
  }

  async history(
    tenantId: string,
    caller: SiteScopeCaller,
    input: SiteEnvironmentHistoryInput,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    this.assertSiteAccess(caller, input.siteId);
    const range = this.normalizeHistoryRange(input.from, input.to, new Date());
    this.assertMetrics(input.metrics);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await this.requireSite(queryRunner.manager, tenantId, input.siteId);
      const [weatherRows, marineRows] = await Promise.all([
        this.latestWeatherRows(queryRunner, {
          tenantId,
          siteId: input.siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from: range.from,
          to: range.to,
          dataType: WeatherDataType.HISTORICAL,
          metrics: input.metrics,
          current: false,
        }),
        this.latestMarineRows(queryRunner, {
          tenantId,
          siteId: input.siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from: range.from,
          to: range.to,
          dataType: WeatherDataType.HISTORICAL,
          metrics: input.metrics,
          current: false,
        }),
      ]);

      return {
        siteId: input.siteId,
        values: this.projectAndDedupe(weatherRows, marineRows, input.metrics, false),
      };
    });
  }

  async forecast(
    tenantId: string,
    caller: SiteScopeCaller,
    siteId: string,
    metrics: EnvironmentMetric[],
    days: number,
  ): Promise<SiteEnvironmentValuesResponse> {
    this.monitoringGate.assertEnabled();
    this.assertSiteAccess(caller, siteId);
    this.assertMetrics(metrics);
    if (!Number.isInteger(days) || days < 1 || days > 7) {
      throw new BadRequestException('Forecast days must be an integer between 1 and 7');
    }

    const from = new Date();
    const to = new Date(from.getTime() + days * DAY_MS);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await this.requireSite(queryRunner.manager, tenantId, siteId);
      const [weatherRows, marineRows] = await Promise.all([
        this.latestWeatherRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from,
          to,
          dataType: WeatherDataType.FORECAST,
          metrics,
          current: false,
        }),
        this.latestMarineRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from,
          to,
          dataType: WeatherDataType.FORECAST,
          metrics,
          current: false,
        }),
      ]);

      return {
        siteId,
        values: this.projectAndDedupe(weatherRows, marineRows, metrics, false),
      };
    });
  }

  async layerCatalog(
    tenantId: string,
    caller: SiteScopeCaller,
    siteId: string,
  ): Promise<EnvironmentLayerResponse[]> {
    this.monitoringGate.assertEnabled();
    this.assertSiteAccess(caller, siteId);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await this.requireSite(queryRunner.manager, tenantId, siteId);
      const cutoff = new Date(Date.now() - OBSERVATION_RETENTION_MS);
      const [weatherRows, marineRows, scenes, syncStates, syncCoverage] = await Promise.all([
        this.latestWeatherRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from: cutoff,
          to: null,
          dataType: null,
          metrics: WEATHER_METRICS.map(({ metric }) => metric),
          current: false,
        }),
        this.latestMarineRows(queryRunner, {
          tenantId,
          siteId,
          monitoringLocationRevision: site.monitoringLocationRevision,
          from: cutoff,
          to: null,
          dataType: null,
          metrics: MARINE_METRICS.map(({ metric }) => metric),
          current: false,
        }),
        queryRunner.manager.find(SatelliteSceneObservation, {
          where: {
            tenantId,
            siteId,
            monitoringLocationRevision: site.monitoringLocationRevision,
            acquiredAt: MoreThanOrEqual(cutoff),
          },
          relations: { coverageAssessments: true },
          order: { acquiredAt: 'ASC' },
        }),
        queryRunner.manager.find(SiteEnvironmentSyncState, {
          where: {
            tenantId,
            siteId,
            monitoringLocationRevision: site.monitoringLocationRevision,
          },
        }),
        queryRunner.manager.find(EnvironmentMetricSyncOutcome, {
          where: {
            tenantId,
            siteId,
            monitoringLocationRevision: site.monitoringLocationRevision,
          },
          order: { completedAt: 'DESC', validFrom: 'ASC', id: 'ASC' },
        }),
      ]);

      const canonicalWeatherRows = orderCanonicalWeatherObservations(weatherRows, false);
      const canonicalMarineRows = orderCanonicalMarineObservations(marineRows, false);
      return ENVIRONMENT_LAYER_CATALOG.map((layer) =>
        this.layerAvailability(
          layer,
          canonicalWeatherRows,
          canonicalMarineRows,
          scenes,
          syncStates,
          syncCoverage,
        ),
      );
    });
  }

  async scenes(
    tenantId: string,
    caller: SiteScopeCaller,
    input: EnvironmentScenesInput,
  ): Promise<EnvironmentSceneCursorConnection> {
    this.monitoringGate.assertEnabled();
    this.assertSiteAccess(caller, input.siteId);
    const range = this.normalizeHistoryRange(input.from, input.to, new Date());
    const { first, after } = normaliseCursorInput(input);
    if (after && !isUUID(after.id)) {
      throw new BadRequestException('Invalid scene cursor');
    }

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await this.requireSite(queryRunner.manager, tenantId, input.siteId);
      const query = queryRunner.manager
        .createQueryBuilder(SatelliteSceneObservation, 'scene')
        .leftJoinAndSelect('scene.coverageAssessments', 'coverageAssessment')
        .where('scene.tenant_id = :tenantId', { tenantId })
        .andWhere('scene.site_id = :siteId', { siteId: input.siteId })
        .andWhere('scene.monitoring_location_revision = :locationRevision', {
          locationRevision: site.monitoringLocationRevision,
        })
        .andWhere('scene.acquired_at BETWEEN :from AND :to', {
          from: range.from,
          to: range.to,
        });

      if (after) {
        query.andWhere(
          '(scene.acquired_at < :cursorAt OR (scene.acquired_at = :cursorAt AND scene.id < :cursorId))',
          { cursorAt: after.createdAt, cursorId: after.id },
        );
      }

      const rows = await query
        .orderBy('scene.acquired_at', 'DESC')
        .addOrderBy('scene.id', 'DESC')
        .take(first + 1)
        .getMany();
      const pagination = buildCursorResponse(
        rows.map((scene) => ({
          id: scene.id,
          createdAt: scene.acquiredAt,
          response: this.sceneResponse(scene),
        })),
        first,
      );

      return {
        siteId: input.siteId,
        edges: pagination.edges.map(({ cursor, node }) => ({
          cursor,
          node: node.response,
        })),
        pageInfo: pagination.pageInfo,
      };
    });
  }

  /**
   * Selects only the row identities that win at least one requested metric.
   * Corrections remain append-only in storage; PostgreSQL performs the
   * metric-level precedence ranking so application memory is bounded by the
   * requested metric/time grid rather than by every historical provider run.
   */
  private async latestWeatherRows(
    queryRunner: QueryRunner,
    selection: LatestObservationSelection,
  ): Promise<WeatherObservation[]> {
    const metrics = selection.metrics.filter((metric) =>
      WEATHER_METRICS.some((definition) => definition.metric === metric),
    );
    if (metrics.length === 0) return [];
    const partition = selection.current ? 'metric' : 'metric, observed_at';
    const validAtOrder = selection.current ? 'observed_at DESC,' : '';
    const identities: ObservationIdentity[] = await queryRunner.query(
      `
        WITH expanded AS (
          SELECT
            observation.id AS observation_id,
            observation.observed_at,
            observation.provider,
            observation.product_id,
            observation.dataset_id,
            observation.source_run_key,
            observation.issued_at,
            observation.fetched_at,
            projected.metric,
            projected.value
          FROM weather_observations AS observation
          CROSS JOIN LATERAL (
            VALUES
              ('AIR_TEMPERATURE', observation.temperature),
              ('WIND_SPEED', observation.wind_speed),
              ('WIND_DIRECTION', observation.wind_direction),
              ('WIND_GUST', observation.wind_gusts),
              ('PRECIPITATION', observation.precipitation),
              ('CLOUD_COVER', observation.cloud_cover),
              ('PRESSURE_MSL', observation.pressure_msl),
              ('RELATIVE_HUMIDITY', observation.relative_humidity)
          ) AS projected(metric, value)
          WHERE observation.tenant_id = $1
            AND observation.site_id = $2
            AND observation.monitoring_location_revision = $3
            AND observation.provider IN ('MET_LOCATIONFORECAST', 'MET_FROST')
            AND observation.observed_at >= $4
            AND ($5::timestamptz IS NULL OR observation.observed_at <= $5)
            AND ($6::varchar IS NULL OR observation.data_type = $6)
            AND projected.metric = ANY($7::text[])
            AND projected.value IS NOT NULL
        ),
        ranked AS (
          SELECT
            observation_id,
            row_number() OVER (
              PARTITION BY ${partition}
              ORDER BY
                ${validAtOrder}
                CASE provider WHEN 'MET_FROST' THEN 0 ELSE 1 END,
                issued_at DESC NULLS LAST,
                fetched_at DESC,
                provider,
                product_id,
                dataset_id,
                source_run_key,
                observation_id
            ) AS metric_version
          FROM expanded
        )
        SELECT DISTINCT observation_id AS id
        FROM ranked
        WHERE metric_version = 1
      `,
      [
        selection.tenantId,
        selection.siteId,
        selection.monitoringLocationRevision,
        selection.from,
        selection.to,
        selection.dataType,
        metrics,
      ],
    );
    if (identities.length === 0) return [];
    return queryRunner.manager.find(WeatherObservation, {
      where: {
        id: In(identities.map(({ id }) => id)),
        tenantId: selection.tenantId,
        siteId: selection.siteId,
        provider: In(CANONICAL_WEATHER_PROVIDERS),
        monitoringLocationRevision: selection.monitoringLocationRevision,
      },
      order: { observedAt: 'ASC', issuedAt: 'DESC', fetchedAt: 'DESC' },
    });
  }

  private async latestMarineRows(
    queryRunner: QueryRunner,
    selection: LatestObservationSelection,
  ): Promise<MarineObservation[]> {
    const metrics = selection.metrics.filter((metric) =>
      MARINE_METRICS.some((definition) => definition.metric === metric),
    );
    if (metrics.length === 0) return [];
    const partition = selection.current
      ? 'metric'
      : 'metric, observed_at, COALESCE(model_depth_m, -1)';
    const validAtOrder = selection.current ? 'observed_at DESC,' : '';
    const identities: ObservationIdentity[] = await queryRunner.query(
      `
        WITH expanded AS (
          SELECT
            observation.id AS observation_id,
            observation.observed_at,
            observation.provider,
            observation.product_id,
            observation.dataset_id,
            observation.source_run_key,
            observation.issued_at,
            observation.fetched_at,
            observation.model_depth_m,
            projected.metric,
            projected.value
          FROM marine_observations AS observation
          CROSS JOIN LATERAL (
            VALUES
              ('WAVE_HEIGHT', observation.wave_height),
              ('WAVE_DIRECTION', observation.wave_direction),
              ('WAVE_PERIOD', observation.wave_period),
              ('CURRENT_SPEED', observation.ocean_current_velocity),
              ('CURRENT_DIRECTION', observation.ocean_current_direction),
              ('SEA_TEMPERATURE', observation.sea_surface_temperature),
              ('SALINITY', observation.salinity),
              ('DISSOLVED_OXYGEN', observation.dissolved_oxygen),
              ('MODEL_CHLOROPHYLL', observation.model_chlorophyll)
          ) AS projected(metric, value)
          WHERE observation.tenant_id = $1
            AND observation.site_id = $2
            AND observation.monitoring_location_revision = $3
            AND observation.provider = 'CMEMS'
            AND observation.observed_at >= $4
            AND ($5::timestamptz IS NULL OR observation.observed_at <= $5)
            AND ($6::varchar IS NULL OR observation.data_type = $6)
            AND projected.metric = ANY($7::text[])
            AND projected.value IS NOT NULL
        ),
        ranked AS (
          SELECT
            observation_id,
            row_number() OVER (
              PARTITION BY ${partition}
              ORDER BY
                ${validAtOrder}
                issued_at DESC NULLS LAST,
                fetched_at DESC,
                provider,
                product_id,
                dataset_id,
                source_run_key,
                observation_id
            ) AS metric_version
          FROM expanded
        )
        SELECT DISTINCT observation_id AS id
        FROM ranked
        WHERE metric_version = 1
      `,
      [
        selection.tenantId,
        selection.siteId,
        selection.monitoringLocationRevision,
        selection.from,
        selection.to,
        selection.dataType,
        metrics,
      ],
    );
    if (identities.length === 0) return [];
    return queryRunner.manager.find(MarineObservation, {
      where: {
        id: In(identities.map(({ id }) => id)),
        tenantId: selection.tenantId,
        siteId: selection.siteId,
        provider: In(CANONICAL_MARINE_PROVIDERS),
        monitoringLocationRevision: selection.monitoringLocationRevision,
      },
      order: { observedAt: 'ASC', issuedAt: 'DESC', fetchedAt: 'DESC' },
    });
  }

  private latestMetricValues(
    weatherRows: WeatherObservation[],
    marineRows: MarineObservation[],
    now: Date,
  ): EnvironmentValueResponse[] {
    const canonicalWeatherRows = orderCanonicalWeatherObservations(weatherRows, true);
    const canonicalMarineRows = orderCanonicalMarineObservations(marineRows, true);
    const values: EnvironmentValueResponse[] = [];
    for (const definition of WEATHER_METRICS) {
      const row = canonicalWeatherRows.find((candidate) => isPresent(definition.read(candidate)));
      if (row) {
        values.push(this.weatherValue(row, definition, definition.read(row)!, true, now));
      }
    }
    for (const definition of MARINE_METRICS) {
      const row = canonicalMarineRows.find((candidate) => isPresent(definition.read(candidate)));
      if (row) {
        values.push(this.marineValue(row, definition, definition.read(row)!, true, now));
      }
    }
    return values;
  }

  private projectAndDedupe(
    weatherRows: WeatherObservation[],
    marineRows: MarineObservation[],
    metrics: EnvironmentMetric[],
    current: boolean,
  ): EnvironmentValueResponse[] {
    const selected = new Set(metrics);
    const values: EnvironmentValueResponse[] = [];
    for (const row of orderCanonicalWeatherObservations(weatherRows, false)) {
      for (const definition of WEATHER_METRICS) {
        if (!selected.has(definition.metric)) {
          continue;
        }
        const value = definition.read(row);
        if (isPresent(value)) {
          values.push(this.weatherValue(row, definition, value, current));
        }
      }
    }
    for (const row of orderCanonicalMarineObservations(marineRows, false)) {
      for (const definition of MARINE_METRICS) {
        if (!selected.has(definition.metric)) {
          continue;
        }
        const value = definition.read(row);
        if (isPresent(value)) {
          values.push(this.marineValue(row, definition, value, current));
        }
      }
    }

    const seen = new Set<string>();
    return values.filter((value) => {
      const key = [value.metric, value.validAt.toISOString(), value.depthM ?? 'surface'].join('|');
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private weatherValue(
    row: CanonicalWeatherObservation,
    definition: MetricDefinition<WeatherObservation>,
    value: number,
    current: boolean,
    now = new Date(),
  ): EnvironmentValueResponse {
    return {
      metric: definition.metric,
      value: Number(value),
      unit: definition.unit,
      source: row.provider,
      semanticClass: row.semanticClass,
      validAt: row.observedAt,
      issuedAt: row.issuedAt ?? null,
      fetchedAt: row.fetchedAt,
      qualityStatus: current
        ? qualityForCurrent(
            row.qualityStatus,
            row.observedAt,
            row.issuedAt,
            row.fetchedAt,
            definition.staleAfterMs,
            now,
          )
        : row.qualityStatus,
      depthM: null,
      requestedDepthM: null,
      datasetId: row.datasetId,
      productId: row.productId,
      variableId: this.persistedWeatherVariableId(row, definition),
      resolutionM: row.horizontalResolutionM ?? null,
      gridCellDistanceM: null,
      locationRevision: row.monitoringLocationRevision,
      stationId: row.stationId ?? null,
      stationDistanceKm: row.stationDistanceKm ?? null,
    };
  }

  private marineValue(
    row: CanonicalMarineObservation,
    definition: MetricDefinition<MarineObservation>,
    value: number,
    current: boolean,
    now = new Date(),
  ): EnvironmentValueResponse {
    return {
      metric: definition.metric,
      value: Number(value),
      unit: definition.unit,
      source: row.provider,
      semanticClass: row.semanticClass,
      validAt: row.observedAt,
      issuedAt: row.issuedAt ?? null,
      fetchedAt: row.fetchedAt,
      qualityStatus: current
        ? qualityForCurrent(
            row.qualityStatus,
            row.observedAt,
            row.issuedAt,
            row.fetchedAt,
            definition.staleAfterMs,
            now,
          )
        : row.qualityStatus,
      depthM: row.modelDepthM ?? null,
      requestedDepthM: row.requestedDepthM ?? null,
      datasetId: row.datasetId,
      productId: row.productId,
      variableId: this.persistedMarineVariableId(row, definition),
      resolutionM: row.horizontalResolutionM ?? null,
      gridCellDistanceM: row.gridCellDistanceM ?? null,
      locationRevision: row.monitoringLocationRevision,
      stationId: null,
      stationDistanceKm: null,
    };
  }

  private persistedWeatherVariableId(
    row: CanonicalWeatherObservation,
    definition: MetricDefinition<WeatherObservation>,
  ): string {
    if (row.provider !== EnvironmentProvider.MET_FROST) {
      return definition.variableId;
    }
    switch (definition.metric) {
      case EnvironmentMetric.PRECIPITATION:
        return 'sum(precipitation_amount PT1H)';
      case EnvironmentMetric.AIR_TEMPERATURE:
        return 'air_temperature';
      case EnvironmentMetric.WIND_SPEED:
        return 'wind_speed';
      case EnvironmentMetric.WIND_DIRECTION:
        return 'wind_from_direction';
      case EnvironmentMetric.RELATIVE_HUMIDITY:
        return 'relative_humidity';
      default:
        return definition.variableId;
    }
  }

  private persistedMarineVariableId(
    row: CanonicalMarineObservation,
    definition: MetricDefinition<MarineObservation>,
  ): string {
    const prefix = `${definition.metric}=`;
    const mapping = row.variableSetId.split(',').find((candidate) => candidate.startsWith(prefix));
    if (!mapping) {
      throw new Error('Canonical marine observation has no variable mapping for its value');
    }
    return mapping.slice(prefix.length).replaceAll('+', ',');
  }

  private layerAvailability(
    layer: MarineLayerDefinition,
    weatherRows: CanonicalWeatherObservation[],
    marineRows: CanonicalMarineObservation[],
    scenes: SatelliteSceneObservation[],
    syncStates: SiteEnvironmentSyncState[],
    syncCoverage: EnvironmentMetricSyncOutcome[],
  ): EnvironmentLayerResponse {
    const providerStates = syncStates.filter((state) => layer.providers.includes(state.provider));
    const range =
      layer.source === 'sentinel'
        ? this.sceneRange(scenes)
        : layer.source === 'met'
          ? this.weatherMetricRange(weatherRows, layer.metric)
          : this.metricRange(marineRows, layer.metric);
    const layerCoverage = syncCoverage.filter(
      (scope) =>
        layer.providers.includes(scope.provider) &&
        (scope.metric === null || scope.metric === layer.metric),
    );
    const dataProviders = this.layerDataProviders(layer, weatherRows, marineRows, range);

    return {
      id: layer.id,
      name: layer.name,
      description: layer.description,
      scientificLabel: layer.scientificLabel,
      source: layer.provider,
      sources: [...layer.providers],
      semanticClass: layer.semanticClass,
      unit: layer.units,
      metric: layer.metric,
      capabilities: [...layer.capabilities],
      supportsDepth: layer.supportsDepth,
      nominalResolutionM: layer.nominalResolutionM,
      resolutionLabel: layer.resolutionLabel,
      minValue: layer.minValue,
      maxValue: layer.maxValue,
      availability: this.availabilityStatus(
        layer,
        range,
        scenes,
        providerStates,
        layerCoverage,
        dataProviders,
      ),
      availableFrom: range?.from ?? null,
      availableTo: range?.to ?? null,
      coverage: this.coverageSummary(layerCoverage),
    };
  }

  private coverageSummary(
    coverage: readonly EnvironmentMetricSyncOutcome[],
  ): EnvironmentCoverageSummaryResponse {
    const failed = coverage.filter((scope) => isFailedScope(scope.outcome)).length;
    const noData = coverage.filter(
      (scope) => scope.outcome === EnvironmentSyncScopeOutcome.NO_DATA,
    ).length;
    const outOfCoverage = coverage.filter(
      (scope) => scope.outcome === EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
    ).length;
    return {
      expected: coverage.length,
      successful: coverage.length - failed,
      failed,
      noData,
      outOfCoverage,
      scopes: coverage.map((scope) => ({
        provider: scope.provider,
        metric: scope.metric,
        scopeKind: scope.scopeKind,
        scopeKey: scope.scopeKey,
        validFrom: scope.validFrom,
        validTo: scope.validTo,
        outcome: scope.outcome,
        errorCode: scope.errorCode,
        observationCount: scope.observationCount,
        completedAt: scope.completedAt,
      })),
    };
  }

  private availabilityStatus(
    layer: MarineLayerDefinition,
    range: AvailabilityRange | undefined,
    scenes: SatelliteSceneObservation[],
    providerStates: SiteEnvironmentSyncState[],
    coverage: readonly EnvironmentMetricSyncOutcome[],
    dataProviders: ReadonlySet<EnvironmentProvider>,
  ): EnvironmentAvailabilityStatus {
    const sourceSignals = layer.providers.map((provider) => {
      const providerCoverage = coverage.filter((scope) => scope.provider === provider);
      const state = providerStates.find((candidate) => candidate.provider === provider);
      const failedCoverage = providerCoverage.filter((scope) => isFailedScope(scope.outcome));
      const successfulCoverage = providerCoverage.filter((scope) => !isFailedScope(scope.outcome));
      const hasCoverage = providerCoverage.length > 0;
      const stateFailed =
        state?.status === EnvironmentSyncStatus.CONFIGURATION_ERROR ||
        state?.status === EnvironmentSyncStatus.PROVIDER_UNAVAILABLE ||
        state?.status === EnvironmentSyncStatus.PARTIAL_FAILURE;
      const stateSuccessful =
        state?.status === EnvironmentSyncStatus.READY ||
        state?.status === EnvironmentSyncStatus.NO_DATA ||
        state?.status === EnvironmentSyncStatus.OUT_OF_COVERAGE ||
        state?.status === EnvironmentSyncStatus.PARTIAL_FAILURE;
      const hasGap = providerCoverage.some(
        (scope) =>
          scope.outcome === EnvironmentSyncScopeOutcome.NO_DATA ||
          scope.outcome === EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
      );

      return {
        provider,
        hasData: dataProviders.has(provider),
        failed: hasCoverage ? failedCoverage.length > 0 : stateFailed,
        successful: hasCoverage ? successfulCoverage.length > 0 : stateSuccessful,
        hasGap,
        outOfCoverageOnly: hasCoverage
          ? successfulCoverage.length > 0 &&
            successfulCoverage.every(
              (scope) => scope.outcome === EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
            )
          : state?.status === EnvironmentSyncStatus.OUT_OF_COVERAGE,
        hasSignal: hasCoverage || state !== undefined,
        waiting:
          state?.status === EnvironmentSyncStatus.PENDING ||
          state?.status === EnvironmentSyncStatus.RUNNING,
        configurationOnly: hasCoverage
          ? failedCoverage.length > 0 &&
            failedCoverage.every(
              (scope) => scope.outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
            )
          : state?.status === EnvironmentSyncStatus.CONFIGURATION_ERROR,
      };
    });
    if (range) {
      const dataSources = sourceSignals.filter((signal) => signal.hasData);
      const completeSource = dataSources.some(
        (signal) => !signal.failed && !signal.hasGap && (signal.successful || !signal.hasSignal),
      );
      if (!completeSource) {
        if (dataSources.some((signal) => signal.failed && signal.successful)) {
          return EnvironmentAvailabilityStatus.PARTIAL_FAILURE;
        }
        if (dataSources.some((signal) => !signal.failed && signal.hasGap)) {
          return EnvironmentAvailabilityStatus.PARTIAL_COVERAGE;
        }
        const failedDataSources = dataSources.filter((signal) => signal.failed);
        if (failedDataSources.length > 0) {
          return failedDataSources.every((signal) => signal.configurationOnly)
            ? EnvironmentAvailabilityStatus.CONFIGURATION_ERROR
            : EnvironmentAvailabilityStatus.PROVIDER_UNAVAILABLE;
        }
      }
    } else {
      if (layer.source === 'sentinel' && scenes.length > 0) {
        if (
          scenes.every(
            (scene) =>
              selectSatelliteCoverageAssessment(scene).coverageStatus ===
              SatelliteCoverageStatus.OUT_OF_COVERAGE,
          )
        ) {
          return EnvironmentAvailabilityStatus.OUT_OF_COVERAGE;
        }
        if (
          scenes.every(
            (scene) =>
              selectSatelliteCoverageAssessment(scene).qualityStatus ===
              EnvironmentQualityStatus.CLOUD_OBSCURED,
          )
        ) {
          return EnvironmentAvailabilityStatus.CLOUD_OBSCURED;
        }
        return EnvironmentAvailabilityStatus.NO_DATA;
      }
      const primarySource = sourceSignals.find((signal) => signal.provider === layer.provider);
      if (
        sourceSignals.some((signal) => signal.waiting) ||
        (primarySource !== undefined && !primarySource.hasSignal)
      ) {
        return EnvironmentAvailabilityStatus.PREPARING;
      }
      const partiallySuccessfulSources = sourceSignals.filter(
        (signal) => signal.failed && signal.successful,
      );
      if (partiallySuccessfulSources.length > 0) {
        return EnvironmentAvailabilityStatus.PARTIAL_FAILURE;
      }
      const successfulSources = sourceSignals.filter(
        (signal) => signal.successful && !signal.failed,
      );
      const failedSources = sourceSignals.filter((signal) => signal.failed);
      if (failedSources.length > 0) {
        return failedSources.every((signal) => signal.configurationOnly)
          ? EnvironmentAvailabilityStatus.CONFIGURATION_ERROR
          : EnvironmentAvailabilityStatus.PROVIDER_UNAVAILABLE;
      }
      if (successfulSources.length > 0) {
        const successfulCoverage = coverage.filter((scope) => !isFailedScope(scope.outcome));
        if (successfulCoverage.length > 0) {
          return successfulCoverage.every(
            (scope) => scope.outcome === EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
          )
            ? EnvironmentAvailabilityStatus.OUT_OF_COVERAGE
            : EnvironmentAvailabilityStatus.NO_DATA;
        }
        return successfulSources.every((signal) => signal.outOfCoverageOnly)
          ? EnvironmentAvailabilityStatus.OUT_OF_COVERAGE
          : EnvironmentAvailabilityStatus.NO_DATA;
      }
    }
    if (!range) {
      return EnvironmentAvailabilityStatus.PREPARING;
    }
    if (
      layer.source === 'sentinel' &&
      scenes.length > 0 &&
      scenes.every(
        (scene) =>
          selectSatelliteCoverageAssessment(scene).qualityStatus ===
          EnvironmentQualityStatus.CLOUD_OBSCURED,
      )
    ) {
      return EnvironmentAvailabilityStatus.CLOUD_OBSCURED;
    }
    return Date.now() - range.freshnessAt.getTime() > range.staleAfterMs
      ? EnvironmentAvailabilityStatus.STALE
      : EnvironmentAvailabilityStatus.READY;
  }

  private layerDataProviders(
    layer: MarineLayerDefinition,
    weatherRows: readonly CanonicalWeatherObservation[],
    marineRows: readonly CanonicalMarineObservation[],
    range: AvailabilityRange | undefined,
  ): ReadonlySet<EnvironmentProvider> {
    if (!range) {
      return new Set<EnvironmentProvider>();
    }
    if (layer.source === 'sentinel') {
      return new Set<EnvironmentProvider>([EnvironmentProvider.CDSE_SENTINEL_2]);
    }
    if (layer.source === 'met') {
      const definition = WEATHER_METRICS.find((candidate) => candidate.metric === layer.metric);
      return new Set<EnvironmentProvider>(
        definition
          ? weatherRows.filter((row) => isPresent(definition.read(row))).map((row) => row.provider)
          : [],
      );
    }
    const definition = MARINE_METRICS.find((candidate) => candidate.metric === layer.metric);
    return new Set<EnvironmentProvider>(
      definition
        ? marineRows.filter((row) => isPresent(definition.read(row))).map((row) => row.provider)
        : [],
    );
  }

  private sceneRange(scenes: SatelliteSceneObservation[]): AvailabilityRange | undefined {
    const usableScenes = scenes.filter((scene) => {
      const qualityStatus = selectSatelliteCoverageAssessment(scene).qualityStatus;
      return (
        qualityStatus === EnvironmentQualityStatus.VALID ||
        qualityStatus === EnvironmentQualityStatus.PROVISIONAL
      );
    });
    if (usableScenes.length === 0) {
      return undefined;
    }
    return {
      from: usableScenes[0]!.acquiredAt,
      to: usableScenes[usableScenes.length - 1]!.acquiredAt,
      freshnessAt: latestDate(
        usableScenes.map((scene) => freshnessReference(scene.acquiredAt, null, scene.fetchedAt)),
      ),
      staleAfterMs: 10 * DAY_MS,
    };
  }

  private metricRange(
    rows: CanonicalMarineObservation[],
    metric: EnvironmentMetric | null,
  ): AvailabilityRange | undefined {
    const definition = MARINE_METRICS.find((candidate) => candidate.metric === metric);
    if (!definition) {
      return undefined;
    }
    const matching = rows.filter((row) => isPresent(definition.read(row)));
    if (matching.length === 0) {
      return undefined;
    }
    return {
      from: matching[0]!.observedAt,
      to: matching[matching.length - 1]!.observedAt,
      freshnessAt: latestDate(
        matching.map((row) => freshnessReference(row.observedAt, row.issuedAt, row.fetchedAt)),
      ),
      staleAfterMs: definition.staleAfterMs,
    };
  }

  private weatherMetricRange(
    rows: CanonicalWeatherObservation[],
    metric: EnvironmentMetric | null,
  ): AvailabilityRange | undefined {
    const definition = WEATHER_METRICS.find((candidate) => candidate.metric === metric);
    if (!definition) {
      return undefined;
    }
    const matching = rows.filter((row) => isPresent(definition.read(row)));
    if (matching.length === 0) {
      return undefined;
    }
    return {
      from: matching[0]!.observedAt,
      to: matching[matching.length - 1]!.observedAt,
      freshnessAt: latestDate(
        matching.map((row) => freshnessReference(row.observedAt, row.issuedAt, row.fetchedAt)),
      ),
      staleAfterMs: definition.staleAfterMs,
    };
  }

  private sceneResponse(scene: SatelliteSceneObservation): EnvironmentSceneResponse {
    const coverage = selectSatelliteCoverageAssessment(scene);
    return {
      id: scene.id,
      sceneId: scene.sceneId,
      collection: scene.collection,
      productId: scene.productId,
      datasetId: scene.datasetId,
      acquiredAt: scene.acquiredAt,
      cloudCoverPercent: scene.cloudCoverPercent ?? null,
      coveragePercent: coverage.coveragePercent,
      coverageStatus: coverage.coverageStatus,
      coverageMethod: coverage.coverageMethod,
      coverageSampleCount: coverage.coverageSampleCount,
      qualityStatus: coverage.qualityStatus,
      locationRevision: scene.monitoringLocationRevision,
      fetchedAt: scene.fetchedAt,
    };
  }

  private assertSiteAccess(caller: SiteScopeCaller, siteId: string): void {
    if (!isUUID(siteId)) {
      throw new BadRequestException('siteId must be a UUID');
    }
    this.siteAuthorization.assertSiteAssignment({ caller, siteId });
  }

  private async requireSite(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<Site> {
    const site = await manager.findOne(Site, {
      where: { tenantId, id: siteId, isActive: true, isDeleted: false },
    });
    if (
      !site ||
      site.type !== SiteType.SEA_CAGE ||
      !site.location ||
      !Number.isFinite(site.location.latitude) ||
      site.location.latitude < -90 ||
      site.location.latitude > 90 ||
      !Number.isFinite(site.location.longitude) ||
      site.location.longitude < -180 ||
      site.location.longitude > 180
    ) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }

  private normalizeHistoryRange(from: Date, to: Date, serverNow: Date): { from: Date; to: Date } {
    if (
      !(from instanceof Date) ||
      !(to instanceof Date) ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime())
    ) {
      throw new BadRequestException('from and to must be valid timestamps');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be before or equal to to');
    }
    if (to.getTime() > serverNow.getTime() + CLIENT_CLOCK_SKEW_TOLERANCE_MS) {
      throw new BadRequestException(
        'History and scene ranges cannot end more than 5 minutes in the future',
      );
    }
    const boundedTo = to.getTime() > serverNow.getTime() ? new Date(serverNow.getTime()) : to;
    if (from.getTime() > boundedTo.getTime()) {
      throw new BadRequestException('History and scene ranges cannot start in the future');
    }
    if (boundedTo.getTime() - from.getTime() > MAX_HISTORY_MS) {
      throw new BadRequestException('History and scene ranges cannot exceed 30 days');
    }
    if (from.getTime() < serverNow.getTime() - MAX_HISTORY_MS) {
      throw new BadRequestException('History and scene ranges are limited to the latest 30 days');
    }
    return { from, to: boundedTo };
  }

  private assertMetrics(metrics: EnvironmentMetric[]): void {
    if (metrics.length < 1 || metrics.length > 12) {
      throw new BadRequestException('Select between 1 and 12 environmental metrics');
    }
    if (new Set(metrics).size !== metrics.length) {
      throw new BadRequestException('Environmental metrics must be unique');
    }
    if (metrics.some((metric) => !METRIC_SET.has(metric))) {
      throw new BadRequestException('Unsupported environmental metric');
    }
  }
}

function isFailedScope(outcome: EnvironmentSyncScopeOutcome): boolean {
  return (
    outcome === EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE ||
    outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
  );
}
