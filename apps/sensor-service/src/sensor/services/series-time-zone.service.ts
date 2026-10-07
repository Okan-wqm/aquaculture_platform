/**
 * The time zone a sensor series is shown and bucketed in.
 *
 * WHY here and not a copy: which zone a site's day is counted in belongs to
 * farm (SiteTimeZoneService: the site's own zone → the tenant's localization
 * → UTC), and feeding counts its days with it. Sensor charts ask farm over
 * `request.farm.resolveTimeZones` instead of keeping their own copy, so a
 * chart day and a feeding day are the same day.
 *
 * Honest failure: when farm cannot answer, or names a zone this database does
 * not know (Node and Postgres ship separate tz data), the series is shown in
 * UTC and says so (`UNAVAILABLE`) instead of guessing.
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import type { SeriesBucketZone } from '@aquaculture/shared-contracts';
import { Injectable, Logger } from '@nestjs/common';
import { NatsRequestReply } from '@platform/event-bus';
import {
  FARM_TIME_ZONE_QUERY_SUBJECTS,
  isResolveFarmTimeZonesResponse,
  MAX_TIME_ZONE_SITE_IDS,
  type ResolveFarmTimeZonesRequest,
  type ResolveFarmTimeZonesResponse,
} from '@platform/event-contracts';
import { In, QueryRunner } from 'typeorm';

import { Sensor } from '../../database/entities/sensor.entity';
import { SeriesTimeZoneSource } from '../dto/channel-reading.dto';

/** A chart read waits this long for farm before showing UTC. */
const FARM_TIME_ZONE_TIMEOUT_MS = 1_500;
/** Farm's answer changes when someone edits a site or the tenant; minutes are fine. */
const FARM_ANSWER_TTL_MS = 5 * 60_000;
const FARM_ANSWER_CACHE_LIMIT = 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The zone a series is shown in, and what the tier policy needs to know about it. */
export interface SeriesTimeZone {
  readonly displayTimeZone: string;
  readonly source: SeriesTimeZoneSource;
  readonly bucketZone: SeriesBucketZone;
}

/** A zone farm named, before Postgres has confirmed it. */
export interface ZoneCandidate {
  readonly zone: string;
  readonly source: SeriesTimeZoneSource;
}

const UTC_SERIES_ZONE: SeriesTimeZone = {
  displayTimeZone: 'UTC',
  source: SeriesTimeZoneSource.UNAVAILABLE,
  bucketZone: { kind: 'utc' },
};

@Injectable()
export class SeriesTimeZoneService {
  private readonly logger = new Logger(SeriesTimeZoneService.name);
  private readonly farmAnswers = new Map<
    string,
    { expiresAt: number; answer: ResolveFarmTimeZonesResponse }
  >();

  constructor(
    private readonly requestReply: NatsRequestReply,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /** The site ids of the sensors, read inside the caller's tenant read. */
  async sitesOf(
    qr: QueryRunner,
    sensorIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    const sensors = await tenantManagerRepo(qr.manager, Sensor).find({
      select: { id: true, siteId: true },
      where: { id: In([...sensorIds]) },
    });
    return new Map(sensors.map((sensor) => [sensor.id, sensor.siteId ?? null]));
  }

  /**
   * The zone farm names for sensors on these sites: the sites' shared zone,
   * or the tenant's when they differ or have none; null when farm cannot
   * answer. Called OUTSIDE any database read, so no connection waits on NATS.
   */
  async candidate(
    tenantId: string,
    siteBySensor: ReadonlyMap<string, string | null>,
  ): Promise<ZoneCandidate | null> {
    const siteIds = [...new Set([...siteBySensor.values()])].filter(
      (siteId): siteId is string => siteId !== null && UUID.test(siteId),
    );
    const answer = await this.farmAnswer(tenantId, siteIds);
    if (answer === null) {
      return null;
    }
    const zones = [...siteBySensor.values()].map((siteId) =>
      siteId === null ? undefined : answer.siteZones[siteId],
    );
    const shared = zones[0];
    const fromSites = zones.length > 0 && shared !== undefined && zones.every((z) => z === shared);
    return fromSites
      ? { zone: shared, source: SeriesTimeZoneSource.SITE }
      : { zone: answer.tenantZone, source: SeriesTimeZoneSource.TENANT };
  }

  /**
   * The candidate checked against Postgres (`qr` is the series read), so
   * buckets and labels use a zone the database can compute in; UTC, marked
   * unavailable, when there is no candidate or Postgres does not know it.
   */
  async validated(qr: QueryRunner, candidate: ZoneCandidate | null): Promise<SeriesTimeZone> {
    if (candidate === null) {
      return UTC_SERIES_ZONE;
    }
    const offset = await this.knownZoneOffset(qr, candidate.zone);
    if (offset === null) {
      this.logger.warn(
        JSON.stringify({ event: 'series_time_zone_unknown_to_database', zone: candidate.zone }),
      );
      return UTC_SERIES_ZONE;
    }
    return {
      displayTimeZone: candidate.zone,
      source: candidate.source,
      bucketZone: offset.utc
        ? { kind: 'utc' }
        : { kind: 'zoned', wholeHourOffset: offset.wholeHour },
    };
  }

  /** Postgres's view of a zone, or null when it does not know the name. */
  private async knownZoneOffset(
    qr: QueryRunner,
    zone: string,
  ): Promise<{ utc: boolean; wholeHour: boolean } | null> {
    const rows = (await qr.query(
      `SELECT EXTRACT(EPOCH FROM utc_offset)::int AS offset_seconds
         FROM pg_timezone_names
        WHERE name = $1`,
      [zone],
    )) as Array<{ offset_seconds: number }>;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      utc: zone === 'UTC' || zone === 'Etc/UTC',
      wholeHour: row.offset_seconds % 3600 === 0,
    };
  }

  private async farmAnswer(
    tenantId: string,
    siteIds: readonly string[],
  ): Promise<ResolveFarmTimeZonesResponse | null> {
    const asked = [...siteIds].sort().slice(0, MAX_TIME_ZONE_SITE_IDS);
    const key = `${tenantId}|${asked.join(',')}`;
    const cached = this.farmAnswers.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.answer;
    }
    try {
      const response = await this.circuitBreaker.execute<unknown>({
        serviceName: 'sensor-farm-time-zones',
        tenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: () =>
          this.requestReply.requestTyped<ResolveFarmTimeZonesRequest, unknown>(
            FARM_TIME_ZONE_QUERY_SUBJECTS.RESOLVE,
            { tenantId, siteIds: asked },
            { timeoutMs: FARM_TIME_ZONE_TIMEOUT_MS },
          ),
      });
      if (!isResolveFarmTimeZonesResponse(response)) {
        this.logFarmFailure('malformed_response');
        return null;
      }
      this.remember(key, response);
      return response;
    } catch (error) {
      this.logFarmFailure('request_failed', error);
      return null;
    }
  }

  private remember(key: string, answer: ResolveFarmTimeZonesResponse): void {
    if (this.farmAnswers.size >= FARM_ANSWER_CACHE_LIMIT) {
      const oldest = this.farmAnswers.keys().next().value;
      if (oldest !== undefined) this.farmAnswers.delete(oldest);
    }
    this.farmAnswers.set(key, { expiresAt: Date.now() + FARM_ANSWER_TTL_MS, answer });
  }

  private logFarmFailure(reason: string, error?: unknown): void {
    this.logger.warn(
      JSON.stringify({
        event: 'series_time_zone_farm_unavailable',
        reason,
        errorType: error instanceof Error ? error.name : undefined,
      }),
    );
  }
}
