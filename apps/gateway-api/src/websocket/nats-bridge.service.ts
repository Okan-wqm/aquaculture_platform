import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, Subscription, StringCodec } from 'nats';

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

  async onModuleInit() {
    const natsEnabled = this.configService.get('NATS_ENABLED', 'true') === 'true';

    if (!natsEnabled) {
      this.logger.log('NATS Bridge is disabled');
      return;
    }

    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    const natsUrl = this.configService.get('NATS_URL', 'nats://localhost:4222');

    try {
      this.connection = await connect({
        servers: natsUrl,
        name: 'gateway-api-websocket-bridge',
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      });

      this.logger.log(`Connected to NATS at ${natsUrl}`);

      // Subscribe to sensor reading events
      await this.subscribeToSensorEvents();

      // Handle connection events
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${(error as Error).message}`);
    }
  }

  private async subscribeToSensorEvents(): Promise<void> {
    if (!this.connection) return;

    // Subscribe to all sensor reading events
    // Pattern: events.SensorReadingReceived.>
    this.subscription = this.connection.subscribe('events.SensorReadingReceived.>');

    this.logger.log('Subscribed to sensor reading events');

    // Process incoming messages
    const subscription = this.subscription;
    if (!subscription) return;

    (async () => {
      for await (const msg of subscription) {
        try {
          const data = this.sc.decode(msg.data);
          const event: NatsEvent = JSON.parse(data);

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

    (async () => {
      for await (const status of this.connection!.status()) {
        switch (status.type) {
          case 'disconnect':
            this.logger.warn('NATS disconnected');
            break;
          case 'reconnect':
            this.logger.log('NATS reconnected');
            break;
          case 'error':
            this.logger.error(`NATS error: ${status.data}`);
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
