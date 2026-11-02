import { PersistentNatsConnection } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x): StringCodec was REMOVED — decode via
// msg.string(). The wire bytes stay UTF-8, so this is byte-for-byte
// compatible with the v2 sensor-service producer during a rolling deploy.
import type { NatsConnection } from '@nats-io/nats-core';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDefaultRegistry, EventUpcasterRegistry } from '@platform/event-contracts';

import { SensorReadingsGateway } from './sensor-readings.gateway';

/** ARCH-C01: Flat reading field → parameter name mapping */
const READING_FIELD_MAP: Record<string, string> = {
  readingTemperature: 'temperature',
  readingPh: 'ph',
  readingDissolvedOxygen: 'dissolvedOxygen',
  readingSalinity: 'salinity',
  readingAmmonia: 'ammonia',
  readingNitrite: 'nitrite',
  readingNitrate: 'nitrate',
  readingTurbidity: 'turbidity',
  readingWaterLevel: 'waterLevel',
};

/**
 * Flat NATS event structure matching sensor-service publisher format (v2).
 * sensor-service publishes flat events via NatsEventBus.publish() which
 * serializes the event object as-is to the `events.<eventType>` subject.
 */
interface NatsEvent {
  eventId: string;
  eventType: string;
  timestamp: string | Date;
  tenantId: string;
  sensorId?: string;
  sensorName?: string;
  farmId?: string;
  pondId?: string;
  version?: number;
  // v2 flat reading fields
  readingTemperature?: number;
  readingPh?: number;
  readingDissolvedOxygen?: number;
  readingSalinity?: number;
  readingAmmonia?: number;
  readingNitrite?: number;
  readingNitrate?: number;
  readingTurbidity?: number;
  readingWaterLevel?: number;
}

/**
 * NATS to WebSocket Bridge
 * Subscribes to NATS sensor events and forwards to WebSocket clients
 */
@Injectable()
export class NatsBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsBridgeService.name);
  /**
   * PLAT-HIGH-939: keeps trying until the broker answers. Options come only
   * from the factory (INFRA-HIGH-238: no TLS or credentials of the bridge's
   * own), and the client carries the subscriptions across reconnects, so they
   * are made once per connection (PLAT-MEDIUM-940).
   */
  private readonly nats = new PersistentNatsConnection({
    name: 'gateway-api-websocket-bridge',
    onConnected: (connection) => {
      this.subscribeToSensorEvents(connection);
      this.subscribeToEdgeIoEvents(connection);
      this.subscribeToEdgeAlarmEvents(connection);
    },
  });
  /** ARCH-C01: Raw NATS doesn't use NatsEventBus — apply upcasters manually */
  private readonly upcasterRegistry: EventUpcasterRegistry = createDefaultRegistry();

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(SensorReadingsGateway) private readonly sensorGateway: SensorReadingsGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsEnabled = this.configService.get<string>('NATS_ENABLED', 'true') === 'true';

    if (!natsEnabled) {
      this.logger.log('NATS Bridge is disabled');
      return;
    }

    this.nats.open();
  }

  async onModuleDestroy(): Promise<void> {
    await this.nats.close();
  }

  private subscribeToSensorEvents(connection: NatsConnection): void {
    // Task 2 (SENSOR-HIGH-092): SensorReading is a high-rate telemetry type
    // routed to the telemetry root (AQUACULTURE_TELEMETRY). The previous
    // 2-segment `events.SensorReading` subject matched NOTHING the sensor
    // subgraph publishes (3-segment events.{tenant}.SensorReading) — the
    // bridge was silently blind; the routed wildcard fixes both at once.
    const subscription = connection.subscribe('telemetry.*.SensorReading');

    this.logger.log('Subscribed to sensor reading events');

    // Process incoming messages
    // SECURITY: Attach .catch() to prevent unhandled rejection on iterator error.
    // Without this, any thrown error becomes an unhandled rejection and the
    // subscription loop terminates silently -- all WebSocket clients stop
    // receiving real-time data permanently until gateway restart.
    (async () => {
      for await (const msg of subscription) {
        try {
          // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
          const data = msg.string();
          // ARCH-C01: Apply upcasters for v1→v2 migration (raw NATS, no NatsEventBus)
          const raw = JSON.parse(data);
          // upcast returns Record<string, unknown>; validated by isValidNatsEvent below
          const event = this.upcasterRegistry.upcast(raw) as unknown as NatsEvent;

          // Runtime schema validation: ensure required fields are present
          // JSON.parse + `as NatsEvent` is only a type cast, not validation.
          if (!this.isValidNatsEvent(event)) {
            this.logger.warn('NATS message failed schema validation, dropping');
            continue;
          }

          this.handleSensorReadingEvent(event);
        } catch (error) {
          this.logger.warn(`Failed to process NATS message: ${(error as Error).message}`);
        }
      }
      this.logger.warn('NATS subscription iterator ended');
    })().catch((error) => {
      this.logger.error(`NATS subscription loop error: ${(error as Error).message}`);
    });
  }

  private subscribeToEdgeIoEvents(connection: NatsConnection): void {
    // SECURITY: Subscribe to tenant-scoped wildcard subject.
    // NatsEventBus.deriveSubject() publishes to events.{tenantId}.EdgeDeviceIoData
    const sub = connection.subscribe('events.*.EdgeDeviceIoData');
    this.logger.log('Subscribed to edge device I/O data events (tenant-scoped wildcard)');

    (async () => {
      for await (const msg of sub) {
        try {
          // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
          const data = JSON.parse(msg.string());
          // SECURITY: Extract tenantId from NATS subject (authoritative), not payload
          const tenantId = msg.subject.split('.')[1];
          const { deviceCode, tagsJson, timestamp } = data;

          if (!tenantId || tenantId === 'system' || !deviceCode) {
            this.logger.warn('EdgeDeviceIoData event missing tenantId or deviceCode, dropping');
            continue;
          }

          // SECURITY: Cross-validate payload tenantId against subject-derived tenantId
          if (data.tenantId && data.tenantId !== tenantId) {
            this.logger.warn(
              `SECURITY: EdgeDeviceIoData tenantId mismatch — subject=${tenantId}, payload=${data.tenantId}. Dropping event.`,
            );
            continue;
          }

          // ARCH-C01: Deserialize tagsJson back to object for WebSocket API backward compat
          const tags = tagsJson ? JSON.parse(tagsJson) : {};
          this.sensorGateway.broadcastEdgeIoData({ tenantId, deviceCode, tags, timestamp });
        } catch (e) {
          this.logger.warn(`Failed to process EdgeDeviceIoData: ${(e as Error).message}`);
        }
      }
    })().catch((error) => {
      this.logger.error(
        `NATS EdgeDeviceIoData subscription loop error: ${(error as Error).message}`,
      );
    });
  }

  private subscribeToEdgeAlarmEvents(connection: NatsConnection): void {
    // SECURITY: Subscribe to tenant-scoped wildcard subject.
    // NatsEventBus.deriveSubject() publishes to events.{tenantId}.EdgeDeviceAlarm
    const sub = connection.subscribe('events.*.EdgeDeviceAlarm');
    this.logger.log('Subscribed to edge device alarm events (tenant-scoped wildcard)');

    (async () => {
      for await (const msg of sub) {
        try {
          // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
          const data = JSON.parse(msg.string());
          // SECURITY: Extract tenantId from NATS subject (authoritative), not payload
          const tenantId = msg.subject.split('.')[1];
          const { deviceCode, alarmsJson, timestamp } = data;

          if (!tenantId || tenantId === 'system' || !deviceCode) {
            this.logger.warn('EdgeDeviceAlarm event missing tenantId or deviceCode, dropping');
            continue;
          }

          // SECURITY: Cross-validate payload tenantId against subject-derived tenantId
          if (data.tenantId && data.tenantId !== tenantId) {
            this.logger.warn(
              `SECURITY: EdgeDeviceAlarm tenantId mismatch — subject=${tenantId}, payload=${data.tenantId}. Dropping event.`,
            );
            continue;
          }

          // ARCH-C01: Deserialize alarmsJson back to array for WebSocket API backward compat
          const alarms = alarmsJson ? JSON.parse(alarmsJson) : [];
          this.sensorGateway.broadcastEdgeAlarm({ tenantId, deviceCode, alarms, timestamp });
        } catch (e) {
          this.logger.warn(`Failed to process EdgeDeviceAlarm: ${(e as Error).message}`);
        }
      }
    })().catch((error) => {
      this.logger.error(
        `NATS EdgeDeviceAlarm subscription loop error: ${(error as Error).message}`,
      );
    });
  }

  private handleSensorReadingEvent(event: NatsEvent): void {
    if (event.eventType !== 'SensorReading') {
      return;
    }

    // SECURITY: Validate tenantId is a valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!event.tenantId || !uuidRegex.test(event.tenantId)) {
      this.logger.warn('NATS event with invalid tenantId format, dropping');
      return;
    }

    // ARCH-C01: Reconstruct readings Record from flat v2 fields for WebSocket API backward compat
    const readings: Record<string, number> = {};
    for (const [flatField, paramName] of Object.entries(READING_FIELD_MAP)) {
      const value = event[flatField as keyof NatsEvent];
      if (typeof value === 'number') {
        readings[paramName] = value;
      }
    }

    // Forward to WebSocket gateway
    const timestamp =
      event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp);

    this.sensorGateway.broadcastSensorReading({
      // Task 1.5: forward the deterministic identity so the client can
      // deduplicate its reconnect window instead of double-rendering.
      eventId: event.eventId,
      sensorId: event.sensorId ?? '',
      sensorName: event.sensorName ?? '',
      tenantId: event.tenantId,
      readings,
      timestamp,
    });
  }

  /**
   * Validate that a parsed NATS event has all required fields.
   * JSON.parse + `as NatsEvent` is only a type cast, not runtime validation.
   * Validates flat event structure matching sensor-service publisher format.
   */
  private isValidNatsEvent(event: NatsEvent): boolean {
    return (
      typeof event === 'object' &&
      event !== null &&
      typeof event.eventType === 'string' &&
      typeof event.tenantId === 'string' &&
      (typeof event.timestamp === 'string' || event.timestamp instanceof Date)
    );
  }

  /**
   * Check if connected to NATS
   */
  isConnected(): boolean {
    return this.nats.isConnected();
  }
}
