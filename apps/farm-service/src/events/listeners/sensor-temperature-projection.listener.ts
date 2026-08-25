/**
 * SensorTemperatureProjectionListener
 *
 * Projects the sensor-service `SensorReading` NATS event stream into the farm
 * `sensor_temperature_latest` read model, so the feeding-rate calculation can
 * read a tank's live water temperature LOCALLY.
 *
 * This replaces the old, prod-broken approach where farm-service reached into the
 * `sensor` schema directly (it has no grant there, and named columns that do not
 * exist). Here farm-service owns a small local read model fed by the event the
 * sensor subgraph already publishes — no synchronous cross-service dependency in
 * the feeding hot path.
 *
 * Idempotent + newest-wins: the upsert only advances a row when the incoming
 * reading is newer, so redelivery / out-of-order delivery cannot regress the
 * latest temperature. Fail-closed on tenant identity; rethrows so NATS redelivers.
 *
 * @module Events/Listeners
 */
import { isValidUUID, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { BaseEvent, SensorReadingEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import {
  WATER_TEMPERATURE_MAX_C,
  WATER_TEMPERATURE_MIN_C,
} from '../../water-quality/services/water-temperature.service';

/** Max tolerated clock skew for a reading's timestamp (5 minutes). */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

@Injectable()
export class SensorTemperatureProjectionListener implements IEventHandler<BaseEvent>, OnModuleInit {
  private readonly logger = new Logger(SensorTemperatureProjectionListener.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — sensor-temperature projection subscription skipped. ' +
          'Feed-rate temperature will fall back to manual measurements only.',
      );
      return;
    }
    // subscribeWildcard builds `telemetry.*.SensorReading` (Task 2 route registry), matching the sensor
    // subgraph's per-tenant `events.{tenantId}.SensorReading` for every tenant.
    await this.eventBus.subscribeWildcard('SensorReading', this);
    this.logger.log('Subscribed to SensorReading for sensor-temperature projection (cross-tenant)');
  }

  getEventType(): string {
    return 'SensorReading';
  }

  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'SensorReading has missing/invalid tenantId — skipping to prevent ' +
          'cross-tenant read-model corruption.',
      );
      return;
    }

    const reading = event as SensorReadingEvent;
    // Only temperature-bearing readings feed this projection.
    if (reading.readingTemperature == null || !isValidUUID(reading.sensorId)) {
      return;
    }
    // Plausibility clamp (GSEC-MEDIUM-002): the projection feeds the feed-rate
    // calculation, so a miscalibrated/poisoned sensor must not be able to store
    // an absurd temperature. Same SSoT bounds as the manual entry path. A bad
    // reading is DROPPED (not thrown) so it cannot DLQ-loop.
    const temperature = reading.readingTemperature;
    if (
      !Number.isFinite(temperature) ||
      temperature < WATER_TEMPERATURE_MIN_C ||
      temperature > WATER_TEMPERATURE_MAX_C
    ) {
      this.logger.warn(
        `SensorReading temperature ${String(temperature)} outside plausible bounds ` +
          `(${WATER_TEMPERATURE_MIN_C}..${WATER_TEMPERATURE_MAX_C} °C) — reading dropped.`,
      );
      return;
    }
    const measuredAt = new Date(event.timestamp);
    if (Number.isNaN(measuredAt.getTime())) {
      return;
    }
    // Future-timestamp guard (GSEC-MEDIUM-002): the newest-wins upsert compares
    // measuredAt, so a single far-future timestamp would pin a wrong temperature
    // that legitimate later readings could never overwrite. Small skew allowed.
    if (measuredAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      this.logger.warn(
        `SensorReading timestamp ${event.timestamp} is in the future — reading dropped.`,
      );
      return;
    }

    // Day bucket is computed in UTC here so the daily rollup is independent of
    // the DB session timezone (a report period is a UTC date range).
    const day = measuredAt.toISOString().slice(0, 10);

    try {
      await runInTenantTransaction(this.dataSource, 'farm', event.tenantId, async (queryRunner) => {
        // Newest-wins BY EVENT IDENTITY (Task 1.5): the eventId (deterministic
        // since Task 1.4) is the watermark. A redelivered event is a no-op,
        // while a DIFFERENT reading at the same millisecond still advances
        // the row — the time-only comparison silently dropped those.
        await queryRunner.manager.query(
          `INSERT INTO "sensor_temperature_latest"
             ("tenantId", "sensorId", "temperatureC", "measuredAt", "lastEventId")
           VALUES ($1, $2, $3, $4, $5::uuid)
           ON CONFLICT ("tenantId", "sensorId") DO UPDATE
             SET "temperatureC" = EXCLUDED."temperatureC",
                 "measuredAt" = EXCLUDED."measuredAt",
                 "lastEventId" = EXCLUDED."lastEventId"
           WHERE "sensor_temperature_latest"."measuredAt" < EXCLUDED."measuredAt"
              OR ("sensor_temperature_latest"."measuredAt" = EXCLUDED."measuredAt"
                  AND "sensor_temperature_latest"."lastEventId" IS DISTINCT FROM EXCLUDED."lastEventId")`,
          [event.tenantId, reading.sensorId, reading.readingTemperature, measuredAt, event.eventId],
        );

        // Daily rollup accumulation (RPT-005). Idempotent by EVENT IDENTITY:
        // the same eventId never counts twice, and a distinct reading at the
        // same millisecond is no longer lost to a strict time comparison.
        await queryRunner.manager.query(
          `INSERT INTO "sensor_temperature_daily"
             ("tenantId", "sensorId", "day", "sumC", "minC", "maxC", "sampleCount", "lastMeasuredAt", "lastEventId")
           VALUES ($1, $2, $3, $4, $4, $4, 1, $5, $6::uuid)
           ON CONFLICT ("tenantId", "sensorId", "day") DO UPDATE
             SET "sumC" = "sensor_temperature_daily"."sumC" + EXCLUDED."sumC",
                 "minC" = LEAST("sensor_temperature_daily"."minC", EXCLUDED."minC"),
                 "maxC" = GREATEST("sensor_temperature_daily"."maxC", EXCLUDED."maxC"),
                 "sampleCount" = "sensor_temperature_daily"."sampleCount" + 1,
                 "lastMeasuredAt" = EXCLUDED."lastMeasuredAt",
                 "lastEventId" = EXCLUDED."lastEventId",
                 "updatedAt" = now()
           WHERE "sensor_temperature_daily"."lastEventId" IS DISTINCT FROM EXCLUDED."lastEventId"`,
          [
            event.tenantId,
            reading.sensorId,
            day,
            reading.readingTemperature,
            measuredAt,
            event.eventId,
          ],
        );
      });
    } catch (error) {
      this.logger.error(
        `SensorReading projection failed for tenant ${event.tenantId.substring(0, 8)}...: ` +
          `${(error as Error).message}`,
        (error as Error).stack,
      );
      // Rethrow so the projection converges via NATS redelivery (idempotent upsert).
      throw error;
    }
  }
}
