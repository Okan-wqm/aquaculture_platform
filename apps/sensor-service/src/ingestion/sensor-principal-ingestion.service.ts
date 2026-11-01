import { createHash } from 'node:crypto';

import {
  listActiveTenantSchemaIdentities,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  deriveEventId,
  type EventId,
  SENSOR_DATA_PAYLOAD_MAX_BYTES,
  SENSOR_DATA_TIMESTAMP_PATTERN,
  validateSensorDataPayload,
} from '@platform/event-contracts';
import client from 'prom-client';
import { DataSource } from 'typeorm';

import { ErasedTenantTombstoneService } from '../compliance/erasure/erased-tenant-tombstone.service';
import type { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SensorDataPromotion } from '../mqtt-identity/sensor-data-promotion.service';
import { parseSensorMqttDataTopic } from '../mqtt-identity/sensor-mqtt-topic';
import { valueAtPath } from './payload-path';
import { SensorReadingRecorder } from './sensor-reading-recorder.service';

/** Why a message on a sensor data topic was dropped (ACKed, nothing stored). */
export type SensorDataDropReason =
  | 'malformed_topic'
  | 'erased_tenant'
  | 'retained'
  | 'too_large'
  | 'not_json'
  | 'schema'
  | 'no_sensor'
  | 'no_channel_value'
  | 'tenant_inactive';

/** What became of one message on `tenants/{tenantId}/sensors/{sensorId}/data`. */
export type SensorDataDisposition =
  | {
      readonly kind: 'recorded';
      readonly tenantId: string;
      readonly sensorId: string;
      readonly rows: number;
      readonly promoted: boolean;
    }
  | { readonly kind: 'dropped'; readonly reason: SensorDataDropReason };

/**
 * How far a payload's own `timestamp` may lie from the receive time and still
 * be trusted (ADR-047 §8): an hour back (a message held by the broker through
 * a listener restart keeps its sample time), a minute ahead (clock drift).
 * Outside it, or absent, the receive time is the sample time.
 */
export const SENSOR_DATA_TIMESTAMP_SKEW_MS = { past: 3_600_000, future: 60_000 } as const;

/**
 * Ingestion of `tenants/{tenantId}/sensors/{sensorId}/data`, the topic only a
 * sensor's own broker principal may publish to (ADR-047 §4): the broker ACL
 * makes the topic name its publisher, so the tenant and the sensor come from
 * it — no topic scan, no topic cache.
 *
 * In order, and before any database work where it can be: the erased-tenant
 * tombstone; a retained message (a sensor publishes with retain=false; a
 * retained one would replay to every new subscriber); the wire size; the
 * payload schema. The per-sensor rate cap is metered earlier, at the broker
 * when the sensor publishes (SensorMqttBrokerAccess), so a backlog the broker
 * delivers at once after a listener restart is stored, not dropped. The sensor is then read inside its
 * tenant's boundary and must still hold its principal and not be suspended.
 * Each enabled channel's value must be a JSON number (numeric strings are
 * refused on this route). The readings are written through
 * SensorReadingRecorder, and the first message that stores one promotes the
 * sensor (SensorDataPromotion), in one tenant transaction. Every drop is
 * counted by reason. A database failure propagates, so the MQTT ack gate
 * holds PUBACK and the broker redelivers.
 */
@Injectable()
export class SensorPrincipalIngestion {
  private readonly logger = new Logger(SensorPrincipalIngestion.name);
  private readonly registry = new client.Registry();
  private readonly dropped = new client.Counter<'reason'>({
    name: 'sensor_principal_messages_dropped_total',
    help: 'Messages on sensor data topics dropped without storing anything, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly refusedValues = new client.Counter({
    name: 'sensor_principal_values_refused_total',
    help: 'Channel values on sensor data topics refused because they were not JSON numbers',
    registers: [this.registry],
  });
  private readonly untrustedTimestamps = new client.Counter<'reason'>({
    name: 'sensor_principal_timestamps_untrusted_total',
    help: 'Sensor data messages stored at their receive time, by why the payload time was not used',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly recorder: SensorReadingRecorder,
    private readonly promotion: SensorDataPromotion,
    private readonly tombstone: ErasedTenantTombstoneService,
    @Optional() serviceMetrics?: ServiceMetricsService,
  ) {
    if (serviceMetrics) {
      serviceMetrics.registerContributor('sensor-principal-ingestion', this.registry);
    }
  }

  async handle(
    topic: string,
    wire: Buffer,
    flags: { readonly retain: boolean },
    receivedAt: Date = new Date(),
  ): Promise<SensorDataDisposition> {
    const target = parseSensorMqttDataTopic(topic);
    if (!target) {
      return this.drop('malformed_topic');
    }
    if (this.tombstone.isErased(target.tenantId)) {
      return this.drop('erased_tenant');
    }
    if (flags.retain) {
      return this.drop('retained');
    }
    if (wire.length > SENSOR_DATA_PAYLOAD_MAX_BYTES) {
      return this.drop('too_large');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(wire.toString('utf8'));
    } catch {
      return this.drop('not_json');
    }
    if (!validateSensorDataPayload(payload) || !isRecord(payload)) {
      return this.drop('schema');
    }
    const data = payload;
    const sampledAt = this.sampleTime(data['timestamp'], receivedAt);
    const eventId = deriveEventId(
      [target.tenantId, target.sensorId, sampledAt.toISOString(), sha256Hex(wire)].join('\u0000'),
    );

    try {
      return await this.store(target, data, sampledAt, eventId, receivedAt);
    } catch (error) {
      // A message the broker held for a tenant deprovisioned since: its schema
      // is gone, so every attempt fails the tenant boundary, and holding PUBACK
      // would reconnect the one shared connection forever. A tenant the
      // platform no longer lists as active is ACK-dropped; a live tenant's
      // failure, or one whose liveness cannot be read, is redelivered.
      if (await this.tenantGone(target.tenantId)) {
        return this.drop('tenant_inactive');
      }
      throw error;
    }
  }

  private async store(
    target: { tenantId: string; sensorId: string },
    data: Record<string, unknown>,
    sampledAt: Date,
    eventId: EventId,
    receivedAt: Date,
  ): Promise<SensorDataDisposition> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      target.tenantId,
      async (qr): Promise<SensorDataDisposition> => {
        const sensor = await tenantManagerRepo(qr.manager, Sensor).findOne({
          where: { id: target.sensorId },
        });
        // The sensor must still hold its principal: a message published
        // just before a rotation, suspension (which withdraws it) or deletion
        // is not stored after it.
        if (!sensor || sensor.parentId || !sensor.mqttUsername) {
          return this.drop('no_sensor');
        }
        const rows = await this.recorder.record(qr.manager, {
          sensor,
          sampledAt,
          eventId,
          valueOf: (channel) => this.numberOf(data, channel),
        });
        if (rows === 0) {
          return this.drop('no_channel_value');
        }
        const promoted = await this.promotion.promoteOnData(qr.manager, sensor, receivedAt);
        return { kind: 'recorded', tenantId: target.tenantId, sensorId: sensor.id, rows, promoted };
      },
    );
  }

  /** True only when the platform's tenant ledger reads and no longer lists the tenant. */
  private async tenantGone(tenantId: string): Promise<boolean> {
    const active = await listActiveTenantSchemaIdentities(this.dataSource).catch(() => null);
    if (active === null) {
      return false;
    }
    const normalized = tenantId.toLowerCase();
    return !active.some((identity) => identity.tenantId === normalized);
  }

  /** The channel's value when it is a finite JSON number; numeric strings are refused here. */
  private numberOf(data: Record<string, unknown>, channel: SensorDataChannel): number | undefined {
    const value = channel.dataPath ? valueAtPath(data, channel.dataPath) : data[channel.channelKey];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    this.refusedValues.inc();
    return undefined;
  }

  /**
   * The payload's timestamp when it is RFC 3339 with an offset and lies within
   * the trusted skew; else the receive time, counted by why.
   */
  private sampleTime(timestamp: unknown, receivedAt: Date): Date {
    if (timestamp === undefined || timestamp === null) {
      this.untrustedTimestamps.inc({ reason: 'absent' });
      return receivedAt;
    }
    if (typeof timestamp !== 'string' || !SENSOR_DATA_TIMESTAMP_PATTERN.test(timestamp)) {
      this.untrustedTimestamps.inc({ reason: 'unusable' });
      return receivedAt;
    }
    const sampled = new Date(timestamp);
    const offset = sampled.getTime() - receivedAt.getTime();
    if (
      Number.isNaN(offset) ||
      offset < -SENSOR_DATA_TIMESTAMP_SKEW_MS.past ||
      offset > SENSOR_DATA_TIMESTAMP_SKEW_MS.future
    ) {
      this.untrustedTimestamps.inc({ reason: 'skew' });
      return receivedAt;
    }
    return sampled;
  }

  private drop(reason: SensorDataDropReason): SensorDataDisposition {
    this.dropped.inc({ reason });
    this.logger.debug(`Sensor data message dropped: ${reason}`);
    return { kind: 'dropped', reason };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
