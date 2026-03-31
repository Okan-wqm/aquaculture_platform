import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, Subscription, StringCodec, ConnectionOptions } from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common';
import * as fs from 'fs';

import { SensorReadingsGateway } from './sensor-readings.gateway';

/**
 * Flat NATS event structure matching sensor-service publisher format.
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
  readings?: Record<string, number>;
  farmId?: string;
  pondId?: string;
  version?: number;
}

/**
 * NATS to WebSocket Bridge
 * Subscribes to NATS sensor events and forwards to WebSocket clients
 */
@Injectable()
export class NatsBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsBridgeService.name);
  private connection: NatsConnection | null = null;
  private subscription: Subscription | null = null;
  private readonly sc = StringCodec();

  constructor(
    private readonly configService: ConfigService,
    private readonly sensorGateway: SensorReadingsGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsEnabled = this.configService.get<string>('NATS_ENABLED', 'true') === 'true';

    if (!natsEnabled) {
      this.logger.log('NATS Bridge is disabled');
      return;
    }

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    /** SEC-H01: Use shared NATS connection factory for consistent auth across all services. */
    const baseOptions = buildNatsConnectionOptions('gateway-api-websocket-bridge');

    const connectionOptions: ConnectionOptions = {
      ...baseOptions,
    };

    // SECURITY: Add TLS configuration if enabled
    const tlsEnabled = this.configService.get<string>('NATS_TLS_ENABLED', 'false') === 'true';
    if (tlsEnabled) {
      const tlsCaPath = this.configService.get<string>('NATS_TLS_CA');
      const tlsCertPath = this.configService.get<string>('NATS_TLS_CERT');
      const tlsKeyPath = this.configService.get<string>('NATS_TLS_KEY');

      connectionOptions.tls = {
        ...(tlsCaPath ? { ca: fs.readFileSync(tlsCaPath, 'utf8') } : {}),
        ...(tlsCertPath ? { cert: fs.readFileSync(tlsCertPath, 'utf8') } : {}),
        ...(tlsKeyPath ? { key: fs.readFileSync(tlsKeyPath, 'utf8') } : {}),
      };
      this.logger.log('NATS TLS enabled for WebSocket bridge');
    }

    // SECURITY: Add authentication if configured
    const authToken = this.configService.get<string>('NATS_AUTH_TOKEN');
    const authUser = this.configService.get<string>('NATS_AUTH_USER');
    const authPass = this.configService.get<string>('NATS_AUTH_PASS');

    if (authToken) {
      connectionOptions.token = authToken;
    } else if (authUser && authPass) {
      connectionOptions.user = authUser;
      connectionOptions.pass = authPass;
    }

    // SECURITY: Production warnings
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (isProduction && !tlsEnabled) {
      this.logger.warn('⚠️  NATS TLS is disabled in production!');
    }

    try {
      this.connection = await connect(connectionOptions);

      this.logger.log(`Connected to NATS at ${connectionOptions.servers}`);

      // Subscribe to sensor reading events
      this.subscribeToSensorEvents();

      // Subscribe to edge device I/O data events
      this.subscribeToEdgeIoEvents();

      // Subscribe to edge device alarm events
      this.subscribeToEdgeAlarmEvents();

      // Handle connection events
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${(error as Error).message}`);
    }
  }

  private subscribeToSensorEvents(): void {
    if (!this.connection) return;

    // Subscribe to all sensor reading events
    // sensor-service publishes to subject: events.SensorReading (no trailing tokens)
    this.subscription = this.connection.subscribe('events.SensorReading');

    this.logger.log('Subscribed to sensor reading events');

    // Process incoming messages
    const subscription = this.subscription;
    if (!subscription) return;

    // SECURITY: Attach .catch() to prevent unhandled rejection on iterator error.
    // Without this, any thrown error becomes an unhandled rejection and the
    // subscription loop terminates silently -- all WebSocket clients stop
    // receiving real-time data permanently until gateway restart.
    (async () => {
      for await (const msg of subscription) {
        try {
          const data = this.sc.decode(msg.data);
          const event = JSON.parse(data) as NatsEvent;

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

  private subscribeToEdgeIoEvents(): void {
    if (!this.connection) return;

    // sensor-service publishes to subject: events.EdgeDeviceIoData (no trailing tokens)
    const sub = this.connection.subscribe('events.EdgeDeviceIoData');
    this.logger.log('Subscribed to edge device I/O data events');

    (async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(this.sc.decode(msg.data));
          const { tenantId, deviceCode, tags, timestamp } = data;

          if (!tenantId || !deviceCode) {
            this.logger.warn('EdgeDeviceIoData event missing tenantId or deviceCode, dropping');
            continue;
          }

          this.sensorGateway.broadcastEdgeIoData({ tenantId, deviceCode, tags, timestamp });
        } catch (e) {
          this.logger.warn(`Failed to process EdgeDeviceIoData: ${(e as Error).message}`);
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS EdgeDeviceIoData subscription loop error: ${(error as Error).message}`);
    });
  }

  private subscribeToEdgeAlarmEvents(): void {
    if (!this.connection) return;

    // sensor-service publishes to subject: events.EdgeDeviceAlarm (no trailing tokens)
    const sub = this.connection.subscribe('events.EdgeDeviceAlarm');
    this.logger.log('Subscribed to edge device alarm events');

    (async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(this.sc.decode(msg.data));
          const { tenantId, deviceCode, alarms, timestamp } = data;

          if (!tenantId || !deviceCode) {
            this.logger.warn('EdgeDeviceAlarm event missing tenantId or deviceCode, dropping');
            continue;
          }

          this.sensorGateway.broadcastEdgeAlarm({ tenantId, deviceCode, alarms, timestamp });
        } catch (e) {
          this.logger.warn(`Failed to process EdgeDeviceAlarm: ${(e as Error).message}`);
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS EdgeDeviceAlarm subscription loop error: ${(error as Error).message}`);
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

    // Forward to WebSocket gateway (flat event structure)
    const timestamp = event.timestamp instanceof Date
      ? event.timestamp.toISOString()
      : String(event.timestamp);

    this.sensorGateway.broadcastSensorReading({
      sensorId: event.sensorId ?? '',
      sensorName: event.sensorName ?? '',
      tenantId: event.tenantId,
      readings: event.readings ?? {},
      timestamp,
    });
  }

  private handleConnectionEvents(): void {
    if (!this.connection) return;

    const connection = this.connection;
    (async () => {
      for await (const status of connection.status()) {
        const statusType = status.type as string;
        switch (statusType) {
          case 'disconnect':
            this.logger.warn('NATS disconnected');
            break;
          case 'reconnect':
            this.logger.log('NATS reconnected - re-subscribing to events');
            // Re-subscribe after reconnect; the previous subscription's
            // async iterator terminates on disconnect.
            this.subscribeToSensorEvents();
            this.subscribeToEdgeIoEvents();
            this.subscribeToEdgeAlarmEvents();
            break;
          case 'error':
            this.logger.error(`NATS error: ${String(status.data)}`);
            break;
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS status loop error: ${(error as Error).message}`);
    });
  }

  private async disconnect(): Promise<void> {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    if (this.connection) {
      await this.connection.drain();
      this.logger.log('NATS connection closed');
    }
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
    return this.connection !== null && !this.connection.isClosed();
  }
}
