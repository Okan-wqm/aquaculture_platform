import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import {
  createBaseEvent,
  type EventId,
  type PersistedReadingMetric,
  projectPersistedReadings,
  type SensorReadingEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { QualityCodes, type SensorMetricInput } from '../database/entities/sensor-metric.entity';
import type { Sensor } from '../database/entities/sensor.entity';
import { siteOfSensor } from '../sensor/utils/sensor-site.util';
import { SensorMetricWriterService } from './sensor-metric-writer.service';

/** One MQTT message's readings, as the route that received it reads them. */
export interface SensorReadingInput {
  readonly sensor: Sensor;
  /** When the values were sampled: the receive time, or a device time the route trusts. */
  readonly sampledAt: Date;
  /** The reading's identity: the outbox idempotency key of its SensorReading. */
  readonly eventId: EventId;
  /**
   * The channel's value in this message, as a finite number, or undefined
   * when the message carries none the route accepts. Each route owns its own
   * rule (the legacy route parses numeric strings; a sensor publishing with
   * its own principal must send JSON numbers).
   */
  readonly valueOf: (channel: SensorDataChannel) => number | undefined;
}

/**
 * Records one MQTT message's readings for a plain sensor: one sensor_metrics
 * row per enabled channel that carries a value (calibrated, quality-coded,
 * stamped with the sensor's current place) and the SensorReading projected
 * from those rows into the transactional outbox — in the caller's tenant
 * transaction, so both commit or neither (SENSOR-CRITICAL-191). The legacy
 * topic route and the route of sensors holding their own broker principal
 * (ADR-047) both write through here.
 */
@Injectable()
export class SensorReadingRecorder {
  private readonly logger = new Logger(SensorReadingRecorder.name);

  // Channel lookup cache: sensorId -> { channels, expiresAt }
  private readonly channelCache = new Map<
    string,
    { channels: SensorDataChannel[]; expiresAt: number }
  >();
  private readonly CHANNEL_CACHE_TTL_MS = 60_000;

  constructor(
    private readonly metricWriter: SensorMetricWriterService,
    // SENSOR-CRITICAL-191: the reading's SensorReading is enqueued in the SAME
    // tenant transaction as its metric rows, and the outbox relay owns the
    // NATS delivery.
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /** Write the reading inside `manager`'s tenant transaction; resolves to the rows written. */
  async record(manager: EntityManager, input: SensorReadingInput): Promise<number> {
    const { sensor, sampledAt } = input;
    const channels = await this.channelsOf(sensor.id, manager);
    const metrics: SensorMetricInput[] = [];
    // SENSOR-CRITICAL-111: the reading event is projected from these rows,
    // so the channel key is captured here where the channel is in scope —
    // the metric row itself carries only the channel UUID.
    const persisted: PersistedReadingMetric[] = [];

    for (const channel of channels) {
      const rawValue = input.valueOf(channel);
      if (rawValue === undefined) {
        continue;
      }

      const calibratedValue = channel.applyCalibration(rawValue);
      let qualityCode: number = QualityCodes.GOOD;
      let qualityBits = 0;

      const validation = channel.validateValue(calibratedValue);
      if (!validation.valid) {
        qualityCode = QualityCodes.BAD;
        qualityBits |= 0x20; // Out of range bit
      } else if (validation.level === 'operational') {
        qualityCode = QualityCodes.UNCERTAIN_EU_EXCEEDED;
      }

      metrics.push({
        time: sampledAt,
        sensorId: sensor.id,
        channelId: channel.id,
        tenantId: sensor.tenantId,
        siteId: sensor.siteId,
        departmentId: sensor.departmentId,
        systemId: sensor.systemId,
        equipmentId: sensor.equipmentId,
        tankId: sensor.tankId,
        pondId: sensor.pondId,
        farmId: sensor.farmId,
        rawValue,
        value: calibratedValue,
        qualityCode,
        qualityBits,
        sourceProtocol: 'mqtt',
        sourceTimestamp: sampledAt,
      });

      persisted.push({
        channelKey: channel.channelKey,
        value: calibratedValue,
        farmId: sensor.farmId,
        pondId: sensor.pondId,
        tankId: sensor.tankId,
      });
    }

    if (metrics.length > 0) {
      await this.metricWriter.writeManaged(metrics, manager);
    }

    // The eventId is the outbox idempotency key: a redelivery of the SAME
    // wire message carries the same one and collapses onto the row already
    // committed.
    const event = this.readingEvent(sensor, persisted, input.eventId, sampledAt);
    if (event) {
      await this.outboxPublisher.enqueue(event, manager, {
        idempotencyKey: event.eventId,
        aggregateId: sensor.id,
      });
    }

    this.logger.debug(`Saved ${metrics.length} metrics for sensor ${sensor.id}`);
    return metrics.length;
  }

  private readingEvent(
    sensor: Sensor,
    persisted: readonly PersistedReadingMetric[],
    eventId: EventId,
    timestamp: Date,
  ): SensorReadingEvent | null {
    // SENSOR-CRITICAL-111: the event body comes from the rows written, never
    // from the wire payload. That is what makes the published value the
    // CALIBRATED one and carries the farm/pond/tank the alert engine's rule
    // query fails closed without.
    const projection = projectPersistedReadings(persisted);
    if (projection.mappedCount === 0) {
      // No stored channel maps onto the flat shape (flow_rate, orp, co2 …).
      // Publishing an empty reading is not a no-op: the alert engine reads it
      // as "nothing is wrong" and auto-resolves open INFO/LOW incidents as
      // "returned to normal". The metrics are persisted either way.
      this.logger.debug(
        `Sensor ${sensor.id}: ${persisted.length} metric(s) stored, none in the reading vocabulary — no SensorReading enqueued`,
      );
      return null;
    }

    const siteId = siteOfSensor(sensor);
    return {
      ...createBaseEvent<SensorReadingEvent>('SensorReading', sensor.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
        // The route's deterministic identity: a re-emission of the SAME
        // reading collapses onto one eventId — and, as the outbox idempotency
        // key, onto one outbox row.
        eventId,
      }),
      eventType: 'SensorReading',
      timestamp: timestamp.toISOString(),
      sensorId: sensor.id,
      ...projection.fields,
      ...(projection.farmId !== undefined ? { farmId: projection.farmId } : {}),
      ...(projection.pondId !== undefined ? { pondId: projection.pondId } : {}),
      ...(projection.tankId !== undefined ? { tankId: projection.tankId } : {}),
      ...(projection.parameter !== undefined ? { parameter: projection.parameter } : {}),
      // The sensor's site: alert-engine places the alarm a rule raises from
      // this reading on it (ALERT-MEDIUM-010), a UUID or nothing
      // (ALERT-MEDIUM-013).
      ...(siteId !== undefined ? { siteId } : {}),
    };
  }

  /** The sensor's enabled channels, cached for a minute. */
  private async channelsOf(sensorId: string, manager: EntityManager): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }

    const channels = await tenantManagerRepo(manager, SensorDataChannel).find({
      where: { sensorId, isEnabled: true },
    });

    this.channelCache.set(sensorId, {
      channels,
      expiresAt: Date.now() + this.CHANNEL_CACHE_TTL_MS,
    });

    return channels;
  }
}
