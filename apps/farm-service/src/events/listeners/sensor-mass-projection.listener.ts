/**
 * SensorMassProjectionListener
 *
 * Projects the sensor-service `SensorReading` NATS event stream into the farm
 * `feeder_silo_mass_latest` read model, so a feeder's weight source can be
 * checked LOCALLY at dose-planning time.
 *
 * WHY this listener has to exist for the weight-based feeder to mean anything:
 * `feeder_capabilities.weight_sensor_id` can be constrained NOT NULL, but "not
 * null" only proves somebody typed a uuid. It cannot distinguish a real load
 * cell from a mistyped id or from a sensor that was specified in a quote and
 * never installed. A projection row proves the one thing that matters — a mass
 * measurement actually arrived, at a known time — which is what
 * `FeederDoseDirectiveService` tests before it will plan a weight-based dose.
 *
 * Mirrors `SensorTemperatureProjectionListener` exactly: same stream, same
 * newest-wins idempotent upsert, same fail-closed tenant identity. Two
 * subscribers on one subject is the event bus's own shape — `subscribeTo`
 * appends handlers per subject and fans out to all of them — so this does not
 * compete with the temperature projection for messages.
 *
 * @module Events/Listeners
 */
import { isValidUUID, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { BaseEvent, SensorReadingEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

/** Max tolerated clock skew for a reading's timestamp (5 minutes). */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Plausibility bounds for a silo mass, in kilograms.
 *
 * A negative mass is a broken or uncalibrated load cell reporting drift below
 * its tare; a mass above this ceiling is not a feed silo. Either way the value
 * must not enter the read model, because a bad reading here does not merely
 * display wrong — it is the evidence the dose planner uses to decide the weight
 * source is alive, so a garbage number would keep a dead cell looking healthy.
 */
export const SILO_MASS_MIN_KG = 0;
export const SILO_MASS_MAX_KG = 1_000_000;

@Injectable()
export class SensorMassProjectionListener implements IEventHandler<BaseEvent>, OnModuleInit {
  private readonly logger = new Logger(SensorMassProjectionListener.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — silo-mass projection subscription skipped. ' +
          'Weight-based feeders will refuse to plan doses until it is up.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('SensorReading', this);
    this.logger.log('Subscribed to SensorReading for feeder silo-mass projection (cross-tenant)');
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
    // Only mass-bearing readings feed this projection.
    if (reading.readingMass == null || !isValidUUID(reading.sensorId)) {
      return;
    }

    const massKg = reading.readingMass;
    if (!Number.isFinite(massKg) || massKg < SILO_MASS_MIN_KG || massKg > SILO_MASS_MAX_KG) {
      this.logger.warn(
        `SensorReading mass ${String(massKg)} kg outside plausible bounds ` +
          `(${String(SILO_MASS_MIN_KG)}..${String(SILO_MASS_MAX_KG)} kg) — reading dropped.`,
      );
      return;
    }

    const measuredAt = new Date(event.timestamp);
    if (Number.isNaN(measuredAt.getTime())) {
      return;
    }
    // Future-timestamp guard: the newest-wins upsert compares measuredAt, so a
    // single far-future stamp would pin a reading that legitimate later ones
    // could never overwrite — and would keep a dead weight source looking fresh
    // for as long as the bogus stamp says.
    if (measuredAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      this.logger.warn(
        `SensorReading timestamp ${event.timestamp} is in the future — reading dropped.`,
      );
      return;
    }

    try {
      await runInTenantTransaction(this.dataSource, 'farm', event.tenantId, async (queryRunner) => {
        await queryRunner.manager.query(
          `INSERT INTO "feeder_silo_mass_latest"
             ("tenantId", "sensorId", "massKg", "measuredAt")
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenantId", "sensorId") DO UPDATE
             SET "massKg" = EXCLUDED."massKg",
                 "measuredAt" = EXCLUDED."measuredAt"
           WHERE "feeder_silo_mass_latest"."measuredAt" < EXCLUDED."measuredAt"`,
          [event.tenantId, reading.sensorId, massKg, measuredAt],
        );
      });
    } catch (error) {
      this.logger.error(
        `Silo-mass projection failed for tenant ${event.tenantId.substring(0, 8)}...: ` +
          `${(error as Error).message}`,
        (error as Error).stack,
      );
      // Rethrow so the projection converges via NATS redelivery (idempotent upsert).
      throw error;
    }
  }
}
