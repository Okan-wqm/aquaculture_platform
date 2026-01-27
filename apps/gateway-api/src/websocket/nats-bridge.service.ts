import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, Subscription, StringCodec, ConnectionOptions } from 'nats';
import * as fs from 'fs';

import { SensorReadingsGateway } from './sensor-readings.gateway';

interface NatsEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  payload: {
    sensorId: string;
    sensorName: string;
    tenantId: string;
    readings: Record<string, number>;
    timestamp: string;
  };
  metadata: {
    tenantId: string;
    source: string;
  };
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
    const natsUrl = this.configService.get<string>('NATS_URL', 'nats://localhost:4222');

    // SECURITY: Build connection options with TLS and auth support
    const connectionOptions: ConnectionOptions = {
      servers: natsUrl,
      name: 'gateway-api-websocket-bridge',
      reconnect: true,
      // SECURITY FIX: Limited reconnect attempts to prevent infinite loop
      maxReconnectAttempts: this.configService.get<number>('NATS_MAX_RECONNECT_ATTEMPTS', 50),
      reconnectTimeWait: 2000,
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

      this.logger.log(`Connected to NATS at ${natsUrl}`);

      // Subscribe to sensor reading events
      this.subscribeToSensorEvents();

      // Handle connection events
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${(error as Error).message}`);
    }
  }

  private subscribeToSensorEvents(): void {
    if (!this.connection) return;

    // Subscribe to all sensor reading events
    // Pattern: events.SensorReadingReceived.>
    this.subscription = this.connection.subscribe('events.SensorReadingReceived.>');

    this.logger.log('Subscribed to sensor reading events');

    // Process incoming messages
    const subscription = this.subscription;
    if (!subscription) return;

    void (async () => {
      for await (const msg of subscription) {
        try {
          const data = this.sc.decode(msg.data);
          const event = JSON.parse(data) as NatsEvent;

          this.handleSensorReadingEvent(event);
        } catch (error) {
          this.logger.warn(`Failed to process NATS message: ${(error as Error).message}`);
        }
      }
    })();
  }

  private handleSensorReadingEvent(event: NatsEvent): void {
    if (event.eventType !== 'SensorReadingReceived') {
      return;
    }

    // Forward to WebSocket gateway
    this.sensorGateway.broadcastSensorReading({
      sensorId: event.payload.sensorId,
      sensorName: event.payload.sensorName,
      tenantId: event.payload.tenantId,
      readings: event.payload.readings,
      timestamp: event.payload.timestamp,
    });
  }

  private handleConnectionEvents(): void {
    if (!this.connection) return;

    const connection = this.connection;
    void (async () => {
      for await (const status of connection.status()) {
        const statusType = status.type as string;
        switch (statusType) {
          case 'disconnect':
            this.logger.warn('NATS disconnected');
            break;
          case 'reconnect':
            this.logger.log('NATS reconnected');
            break;
          case 'error':
            this.logger.error(`NATS error: ${String(status.data)}`);
            break;
        }
      }
    })();
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
   * Check if connected to NATS
   */
  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
