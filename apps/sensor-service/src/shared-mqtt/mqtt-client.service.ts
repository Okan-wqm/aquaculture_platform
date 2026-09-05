import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { MqttClient } from 'mqtt';

/**
 * MQTT subscription callback type
 */
export type MqttMessageHandler = (topic: string, message: Buffer) => void | Promise<void>;

/**
 * MQTT Connection State
 */
export enum MqttConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  CIRCUIT_OPEN = 'circuit_open',
}

/**
 * Shared MQTT Client Service
 *
 * Provides a single MQTT connection for the sensor-service.
 * This service is shared between IngestionModule and EdgeDeviceModule
 * to break circular dependencies.
 *
 * Features:
 * - Exponential backoff reconnection
 * - Circuit breaker pattern
 * - Graceful degradation
 * - Resource cleanup on shutdown
 *
 * SOLID Principles:
 * - Single Responsibility: MQTT connection lifecycle
 * - Open/Closed: Extensible via message handlers
 * - Interface Segregation: Simple handler interface
 */
@Injectable()
export class MqttClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttClientService.name);
  private client: MqttClient | null = null;
  private connectionState: MqttConnectionState = MqttConnectionState.DISCONNECTED;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 20; // Increased from 10
  private readonly baseReconnectDelayMs = 1000; // Start with 1 second
  private readonly maxReconnectDelayMs = 60000; // Max 1 minute
  private messageHandlers: MqttMessageHandler[] = [];
  private subscribedTopics: Set<string> = new Set();
  private circuitResetTimeout: NodeJS.Timeout | null = null;
  private readonly circuitResetDelayMs = 300000; // 5 minutes circuit breaker reset
  private isShuttingDown = false;
  private connectCallbacks: Array<() => void | Promise<void>> = [];
  /** Per-message settle budget before the ack gate force-reconnects. */
  private static readonly HANDLER_SETTLE_DEADLINE_MS = 10_000;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const mqttEnabled = this.configService.get('MQTT_ENABLED', 'true') === 'true';

    if (!mqttEnabled) {
      this.logger.log('MQTT Client is disabled');
      return;
    }

    // SENSOR-CRITICAL-086: fail closed at boot. A missing stable identity
    // would silently degrade to per-process clientIds, discarding the
    // broker-side session (and its unacked QoS1 backlog) on every restart.
    this.requireClientIdPrefix();

    // Delay MQTT connection to allow HTTP server to fully start first.
    // go-auth calls back to our /mqtt/auth endpoint during CONNECT,
    // so the HTTP server must be listening before we attempt MQTT connection.
    const startupDelayMs = 5000;
    this.logger.log(
      `Delaying MQTT connection by ${startupDelayMs}ms to ensure HTTP server is ready`,
    );
    setTimeout(() => {
      if (this.isShuttingDown) return;
      this.connect().catch((error) => {
        this.logger.warn(
          `MQTT broker unavailable at startup: ${error.message}. Will retry in background.`,
        );
        this.scheduleReconnect();
      });
    }, startupDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('MqttClientService shutting down...');

    // Clear circuit breaker reset timeout
    if (this.circuitResetTimeout) {
      clearTimeout(this.circuitResetTimeout);
      this.circuitResetTimeout = null;
    }

    // Clear all message handlers to prevent processing during shutdown
    this.messageHandlers = [];

    await this.disconnect();
    this.logger.log('MqttClientService shutdown complete');
  }

  /**
   * Connect to MQTT broker with exponential backoff and circuit breaker
   */
  async connect(): Promise<void> {
    // Check circuit breaker state
    if (this.connectionState === MqttConnectionState.CIRCUIT_OPEN) {
      this.logger.warn('Circuit breaker is open. Connection blocked until reset.');
      throw new Error('Circuit breaker open - MQTT connections temporarily disabled');
    }

    if (this.client && this.connectionState === MqttConnectionState.CONNECTED) {
      this.logger.debug('MQTT client already connected');
      return;
    }

    if (this.isShuttingDown) {
      this.logger.debug('Service is shutting down, skipping connection');
      return;
    }

    const brokerUrl = this.configService.get<string>('MQTT_BROKER_URL', 'mqtt://localhost:1883');
    const username = this.configService.get<string>('MQTT_USERNAME');
    const password = this.configService.get<string>('MQTT_PASSWORD');
    // Stable identity: MQTT_CLIENT_ID prefix + fixed suffix. The old
    // PID/timestamp clientId made every restart a NEW client, so the broker
    // dropped the persistent session — and with it every unacked QoS1
    // message — each time the process recycled (SENSOR-CRITICAL-086).
    const clientId = `${this.requireClientIdPrefix()}-main`;

    this.logger.log(`Connecting to MQTT broker: ${brokerUrl}`);
    this.connectionState = MqttConnectionState.CONNECTING;

    const options: mqtt.IClientOptions = {
      clientId,
      // Persistent session: the broker retains subscriptions and the unacked
      // QoS1 backlog across reconnects — the redelivery leg of the
      // ack-after-commit contract.
      clean: false,
      keepalive: 60,
      reconnectPeriod: 0, // Disable auto-reconnect, we handle it manually
      connectTimeout: 30000,
    };

    if (username) {
      options.username = username;
      options.password = password;
    }

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(brokerUrl, options);

      // SENSOR-CRITICAL-086 (Task 1 Step 1.2): own the QoS ack gate. For
      // QoS 1 the library sends PUBACK only when handleMessage invokes its
      // callback (build/lib/handlers/publish.js case 1). Dispatching here —
      // instead of via the 'message' event, which fires BEFORE
      // handleMessage — makes this the SINGLE dispatch point: the broker
      // keeps the message in this persistent session until every registered
      // handler settled durably; a failure or deadline force-reconnects
      // without acking so the session redelivers.
      this.client.handleMessage = (
        packet: mqtt.IPublishPacket,
        done: (error?: Error) => void,
      ): void => {
        this.dispatchDurable(packet, done);
      };

      this.client.on('connect', () => {
        this.connectionState = MqttConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        this.logger.log('Connected to MQTT broker');

        // Resubscribe to previously subscribed topics (await for reliability)
        this.resubscribeToTopics()
          .then(() => {
            this.fireConnectCallbacks();
            resolve();
          })
          .catch((err) => {
            this.logger.error(`Failed to resubscribe: ${err.message}`);
            this.fireConnectCallbacks();
            resolve(); // Don't fail connection for subscription errors
          });
      });

      this.client.on('error', (error) => {
        this.logger.error(`MQTT error: ${error.message}`);
        if (this.connectionState === MqttConnectionState.CONNECTING) {
          this.connectionState = MqttConnectionState.DISCONNECTED;
          reject(error);
        }
      });

      this.client.on('close', () => {
        const wasConnected = this.connectionState === MqttConnectionState.CONNECTED;
        this.connectionState = MqttConnectionState.DISCONNECTED;
        this.logger.warn('MQTT connection closed');

        // Trigger reconnection for any unexpected close (not just after successful connection)
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.client.on('offline', () => {
        this.logger.warn('MQTT client is offline');
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;
    if (this.connectionState === MqttConnectionState.RECONNECTING) return;
    if (this.connectionState === MqttConnectionState.CIRCUIT_OPEN) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Max reconnect attempts (${this.maxReconnectAttempts}) reached. Opening circuit breaker.`,
      );
      this.openCircuitBreaker();
      return;
    }

    // Exponential backoff with jitter
    const exponentialDelay = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs,
    );
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    const delay = Math.floor(exponentialDelay + jitter);

    this.logger.log(
      `Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );
    this.connectionState = MqttConnectionState.RECONNECTING;

    setTimeout(() => {
      if (this.isShuttingDown) return;

      this.connect().catch((error) => {
        this.logger.warn(`Reconnection failed: ${error.message}`);
        // scheduleReconnect will be called again from 'close' event
      });
    }, delay);
  }

  /**
   * Open circuit breaker to stop connection attempts temporarily
   */
  private openCircuitBreaker(): void {
    this.connectionState = MqttConnectionState.CIRCUIT_OPEN;
    this.logger.warn(`Circuit breaker OPEN. Will reset in ${this.circuitResetDelayMs / 1000}s`);

    // Disconnect any existing client
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }

    // Schedule circuit reset
    this.circuitResetTimeout = setTimeout(() => {
      if (this.isShuttingDown) return;

      this.logger.log('Circuit breaker RESET. Reconnection allowed.');
      this.connectionState = MqttConnectionState.DISCONNECTED;
      this.reconnectAttempts = 0;
      this.circuitResetTimeout = null;

      // Attempt to reconnect
      this.connect().catch((error) => {
        this.logger.warn(`Post-reset connection failed: ${error.message}`);
      });
    }, this.circuitResetDelayMs);
  }

  /**
   * Get current connection state
   */
  getConnectionState(): MqttConnectionState {
    return this.connectionState;
  }

  /** One-shot callback. Fired on the next successful connect, then removed. */
  onceConnected(callback: () => void | Promise<void>): void {
    if (this.connectionState === MqttConnectionState.CONNECTED) {
      Promise.resolve(callback()).catch((err) =>
        this.logger.error(`onceConnected callback error: ${err}`),
      );
    } else {
      this.connectCallbacks.push(callback);
    }
  }

  private fireConnectCallbacks(): void {
    const callbacks = [...this.connectCallbacks];
    this.connectCallbacks = [];
    for (const cb of callbacks) {
      Promise.resolve(cb()).catch((err) => this.logger.error(`Connect callback error: ${err}`));
    }
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (!this.client) return;

    const client = this.client;
    return new Promise((resolve) => {
      client.end(false, {}, () => {
        this.logger.log('Disconnected from MQTT broker');
        this.connectionState = MqttConnectionState.DISCONNECTED;
        resolve();
      });
    });
  }

  /**
   * Check if connected to MQTT broker
   */
  isConnectedToBroker(): boolean {
    return this.connectionState === MqttConnectionState.CONNECTED;
  }

  /**
   * Get the underlying MQTT client (for advanced use cases)
   */
  getClient(): MqttClient | null {
    return this.client;
  }

  /**
   * Subscribe to topics.
   * LOW-003: Sends a single SUBSCRIBE packet for all topics using the object form
   * of mqtt.Client.subscribe(), instead of N sequential SUBSCRIBE packets.
   */
  async subscribe(topics: string | string[], qos: 0 | 1 | 2 = 1): Promise<void> {
    if (!this.client || !this.isConnectedToBroker()) {
      throw new Error('Not connected to MQTT broker');
    }

    const topicList = Array.isArray(topics) ? topics : [topics];

    if (topicList.length === 0) return;

    // Build topic → QoS map for a single SUBSCRIBE packet
    const topicsMap: Record<string, { qos: 0 | 1 | 2 }> = {};
    for (const topic of topicList) {
      topicsMap[topic] = { qos };
    }

    await new Promise<void>((resolve, reject) => {
      this.client!.subscribe(topicsMap, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to topics: ${err.message}`);
          reject(err);
        } else {
          for (const topic of topicList) {
            this.subscribedTopics.add(topic);
          }
          this.logger.log(`Subscribed to ${topicList.length} topic(s) in single SUBSCRIBE packet`);
          resolve();
        }
      });
    });
  }

  /**
   * Unsubscribe from topics
   */
  async unsubscribe(topics: string | string[]): Promise<void> {
    if (!this.client) return;

    const topicList = Array.isArray(topics) ? topics : [topics];

    for (const topic of topicList) {
      await new Promise<void>((resolve) => {
        this.client!.unsubscribe(topic, {}, () => {
          this.subscribedTopics.delete(topic);
          resolve();
        });
      });
    }
  }

  /**
   * Publish message to topic
   */
  async publish(topic: string, message: string | object, qos: 0 | 1 | 2 = 1): Promise<void> {
    if (!this.client || !this.isConnectedToBroker()) {
      throw new Error('Not connected to MQTT broker');
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, { qos }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Register a message handler
   * Multiple handlers can be registered; all will be called for each message
   */
  addMessageHandler(handler: MqttMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Remove a message handler
   */
  removeMessageHandler(handler: MqttMessageHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  /**
   * Handle one incoming PUBLISH with the ack gate held open. The library's
   * done-callback releases PUBACK (QoS 1); it is invoked ONLY after every
   * registered handler settled. A handler failure or the settle deadline
   * never acks and instead force-reconnects, so the broker's persistent
   * session redelivers the message.
   */
  private dispatchDurable(packet: mqtt.IPublishPacket, done: (error?: Error) => void): void {
    if (this.isShuttingDown) {
      // No dispatch, no ack: an in-flight message at shutdown must be
      // redelivered from the persistent session after the restart, not
      // silently consumed.
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      done();
    };
    const fail = (reason: string, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      this.logger.error(
        `MQTT message not settled (${reason}) on topic ${packet.topic}` +
          `${error ? `: ${error.message}` : ''} — left unacked for persistent-session redelivery`,
      );
      this.forceRedelivery();
    };

    timer = setTimeout(
      () => fail('handler deadline exceeded'),
      MqttClientService.HANDLER_SETTLE_DEADLINE_MS,
    );

    // mqtt-packet types payload as string | Buffer; without a custom
    // parsePayload it is always the raw Buffer, but normalize so the handler
    // contract (Buffer) holds either way.
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);

    Promise.all(
      this.messageHandlers.map((handler) =>
        Promise.resolve().then(() => handler(packet.topic, payload)),
      ),
    ).then(settle, (error: Error) => fail('handler failure', error));
  }

  /**
   * Tear the connection down WITHOUT acking in-flight messages. The 'close'
   * handler schedules the reconnect; the persistent session (clean:false,
   * stable clientId) makes the broker redeliver everything unacked.
   */
  private forceRedelivery(): void {
    if (!this.client || this.isShuttingDown) return;
    this.logger.warn(
      'MQTT force-reconnect: unacked QoS1 messages stay queued in the persistent session',
    );
    this.client.end(true);
  }

  /**
   * The stable client-identity prefix (SENSOR-CRITICAL-086). Required:
   * without it the clientId degenerates to per-process randomness and the
   * broker-side session is destroyed on every restart.
   */
  private requireClientIdPrefix(): string {
    const prefix = this.configService.get<string>('MQTT_CLIENT_ID');
    if (!prefix || prefix.trim().length === 0) {
      throw new Error(
        'MQTT_CLIENT_ID is required: persistent QoS1 sessions need a stable client identity ' +
          '(SENSOR-CRITICAL-086). Set e.g. MQTT_CLIENT_ID=aqua-sensor-service in the service environment.',
      );
    }
    return prefix.trim();
  }

  /**
   * Resubscribe to topics after reconnection
   * Returns a promise that resolves when all resubscriptions complete
   */
  private async resubscribeToTopics(): Promise<void> {
    if (this.subscribedTopics.size === 0) return;
    if (!this.client) return;

    this.logger.log(`Resubscribing to ${this.subscribedTopics.size} topics...`);

    const resubscribePromises: Promise<void>[] = [];

    for (const topic of this.subscribedTopics) {
      const promise = new Promise<void>((resolve) => {
        this.client?.subscribe(topic, { qos: 1 }, (err) => {
          if (err) {
            this.logger.error(`Failed to resubscribe to ${topic}: ${err.message}`);
          } else {
            this.logger.debug(`Resubscribed to ${topic}`);
          }
          resolve(); // Always resolve, even on error, to not block other resubscriptions
        });
      });
      resubscribePromises.push(promise);
    }

    await Promise.all(resubscribePromises);
    this.logger.log(`Resubscription complete for ${this.subscribedTopics.size} topics`);
  }

  /**
   * Force reset circuit breaker (for manual recovery)
   */
  resetCircuitBreaker(): void {
    if (this.connectionState !== MqttConnectionState.CIRCUIT_OPEN) {
      this.logger.debug('Circuit breaker is not open, nothing to reset');
      return;
    }

    if (this.circuitResetTimeout) {
      clearTimeout(this.circuitResetTimeout);
      this.circuitResetTimeout = null;
    }

    this.logger.log('Circuit breaker manually reset');
    this.connectionState = MqttConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
  }
}
