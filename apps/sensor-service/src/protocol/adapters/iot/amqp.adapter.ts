import { Injectable } from '@nestjs/common';

import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';
import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
  DataSubscription,
  DataCallback,
  ErrorCallback,
} from '../base-protocol.adapter';

export interface AmqpConfiguration {
  sensorId?: string;
  tenantId?: string;
  host: string;
  port: number;
  vhost: string;
  username: string;
  password: string;
  // Exchange & Queue
  exchangeName: string;
  exchangeType: 'direct' | 'fanout' | 'topic' | 'headers';
  queueName: string;
  routingKey: string;
  // Options
  durable: boolean;
  prefetchCount: number;
  heartbeat: number;
  // TLS
  useTls: boolean;
  caCert?: string;
  // Data
  messageFormat: 'json' | 'text' | 'binary';
}

interface AmqpMessage {
  content: Buffer;
}

interface AmqpChannel {
  prefetch: (count: number) => Promise<void>;
  assertExchange: (name: string, type: string, options: { durable: boolean }) => Promise<void>;
  assertQueue: (name: string, options: { durable: boolean }) => Promise<{ queue: string }>;
  bindQueue: (queue: string, exchange: string, routingKey: string) => Promise<void>;
  close: () => Promise<void>;
  get: (queue: string, options: { noAck: boolean }) => Promise<AmqpMessage | false>;
  consume: (queue: string, callback: (msg: AmqpMessage | null) => void) => Promise<{ consumerTag: string }>;
  ack: (msg: AmqpMessage) => void;
  cancel: (consumerTag: string) => Promise<void>;
}

interface AmqpConnection {
  createChannel: () => Promise<AmqpChannel>;
  close: () => Promise<void>;
}

interface AmqpConnectionData {
  connection: AmqpConnection;
  channel: AmqpChannel;
  config: AmqpConfiguration;
  queueName: string;
}

@Injectable()
export class AmqpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'AMQP';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.MESSAGE_QUEUE;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'AMQP';
  readonly description = 'Advanced Message Queuing Protocol - Enterprise messaging (RabbitMQ, etc.)';

  protected amqpConnections = new Map<string, AmqpConnectionData>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const amqpConfig = config as unknown as AmqpConfiguration;

    // Dynamic import
    const amqp = await import('amqplib');

    const protocol = amqpConfig.useTls ? 'amqps' : 'amqp';
    const url = `${protocol}://${amqpConfig.username}:${amqpConfig.password}@${amqpConfig.host}:${amqpConfig.port}/${encodeURIComponent(amqpConfig.vhost)}`;

    const connection = await amqp.connect(url, {
      heartbeat: amqpConfig.heartbeat,
    }) as unknown as AmqpConnection;

    const channel = await connection.createChannel();
    await channel.prefetch(amqpConfig.prefetchCount);

    // Assert exchange and queue
    await channel.assertExchange(amqpConfig.exchangeName, amqpConfig.exchangeType, { durable: amqpConfig.durable });
    const q = await channel.assertQueue(amqpConfig.queueName, { durable: amqpConfig.durable });
    await channel.bindQueue(q.queue, amqpConfig.exchangeName, amqpConfig.routingKey);

    const handle = this.createConnectionHandle(
      amqpConfig.sensorId ?? 'unknown',
      amqpConfig.tenantId ?? 'unknown',
      { host: amqpConfig.host, queueName: amqpConfig.queueName }
    );

    this.amqpConnections.set(handle.id, { connection, channel, config: amqpConfig, queueName: q.queue });
    this.logConnectionEvent('connect', handle, { host: amqpConfig.host });
    return handle;
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const connData = this.amqpConnections.get(handle.id);
    if (connData) {
      try {
        await connData.channel.close();
        await connData.connection.close();
      } catch (e) {
        this.logger.warn('Error closing AMQP connection', e);
      }
      this.amqpConnections.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.withTimeout(this.connect(config), 30000, 'Connection timeout');
      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        latencyMs,
        diagnostics: { connectionTimeMs: latencyMs },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      if (handle) await this.disconnect(handle);
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const connData = this.amqpConnections.get(handle.id);
    if (!connData) throw new Error('Connection not found');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Read timeout')), 30000);

      connData.channel.get(connData.queueName, { noAck: true }).then((msg: AmqpMessage | false) => {
        clearTimeout(timeout);
        if (msg) {
          const data = this.parseMessage(msg.content, connData.config);
          this.updateLastActivity(handle);
          resolve(data);
        } else {
          reject(new Error('No message available'));
        }
      }).catch((err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async subscribeToData(
    handle: ConnectionHandle,
    onData: DataCallback,
    onError?: ErrorCallback
  ): Promise<DataSubscription> {
    const connData = this.amqpConnections.get(handle.id);
    if (!connData) throw new Error('Connection not found');

    let isActive = true;
    const consumerTag = await connData.channel.consume(connData.queueName, (msg: AmqpMessage | null) => {
      if (msg) {
        try {
          const data = this.parseMessage(msg.content, connData.config);
          this.updateLastActivity(handle);
          onData(data);
          connData.channel.ack(msg);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    return {
      id: consumerTag.consumerTag,
      unsubscribe: async () => {
        isActive = false;
        await connData.channel.cancel(consumerTag.consumerTag);
      },
      isActive: () => isActive,
    };
  }

  private parseMessage(content: Buffer, config: AmqpConfiguration): SensorReadingData {
    const timestamp = new Date();
    let values: Record<string, number | string | boolean | null> = {};

    switch (config.messageFormat) {
      case 'json':
        try {
          values = JSON.parse(content.toString());
        } catch {
          values = { raw: content.toString() };
        }
        break;
      case 'text':
        values = { value: content.toString() };
        break;
      case 'binary':
        values = { hex: content.toString('hex') };
        break;
    }

    return { timestamp, values, quality: 100, source: 'amqp' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<AmqpConfiguration>;

    if (!cfg.host) errors.push(this.validationError('host', 'Host is required'));
    if (!cfg.username) errors.push(this.validationError('username', 'Username is required'));
    if (!cfg.password) errors.push(this.validationError('password', 'Password is required'));
    if (!cfg.exchangeName) errors.push(this.validationError('exchangeName', 'Exchange name is required'));
    if (!cfg.queueName) errors.push(this.validationError('queueName', 'Queue name is required'));

    if (!cfg.useTls) {
      warnings.push(this.validationWarning('useTls', 'Connection is not encrypted'));
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'AMQP Configuration',
      required: ['host', 'username', 'password', 'exchangeName', 'queueName'],
      properties: {
        host: {
          type: 'string',
          title: 'Host',
          'ui:placeholder': 'localhost',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        port: {
          type: 'integer',
          title: 'Port',
          default: 5672,
          'ui:order': 2,
          'ui:group': 'connection',
        },
        vhost: {
          type: 'string',
          title: 'Virtual Host',
          default: '/',
          'ui:order': 3,
          'ui:group': 'connection',
        },
        username: {
          type: 'string',
          title: 'Username',
          default: 'guest',
          'ui:order': 4,
          'ui:group': 'authentication',
        },
        password: {
          type: 'string',
          title: 'Password',
          format: 'password',
          'ui:order': 5,
          'ui:group': 'authentication',
        },
        exchangeName: {
          type: 'string',
          title: 'Exchange Name',
          'ui:order': 6,
          'ui:group': 'messaging',
        },
        exchangeType: {
          type: 'string',
          title: 'Exchange Type',
          enum: ['direct', 'fanout', 'topic', 'headers'],
          default: 'direct',
          'ui:order': 7,
          'ui:group': 'messaging',
        },
        queueName: {
          type: 'string',
          title: 'Queue Name',
          'ui:order': 8,
          'ui:group': 'messaging',
        },
        routingKey: {
          type: 'string',
          title: 'Routing Key',
          'ui:order': 9,
          'ui:group': 'messaging',
        },
        durable: {
          type: 'boolean',
          title: 'Durable',
          default: false,
          'ui:order': 10,
          'ui:group': 'messaging',
        },
        prefetchCount: {
          type: 'integer',
          title: 'Prefetch Count',
          default: 1,
          'ui:order': 11,
          'ui:group': 'advanced',
        },
        heartbeat: {
          type: 'integer',
          title: 'Heartbeat (seconds)',
          default: 60,
          'ui:order': 12,
          'ui:group': 'advanced',
        },
        useTls: {
          type: 'boolean',
          title: 'Use TLS',
          default: false,
          'ui:order': 13,
          'ui:group': 'security',
        },
        messageFormat: {
          type: 'string',
          title: 'Message Format',
          enum: ['json', 'text', 'binary'],
          default: 'json',
          'ui:order': 14,
          'ui:group': 'data',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'vhost'] },
        { name: 'authentication', title: 'Authentication', fields: ['username', 'password'] },
        { name: 'messaging', title: 'Messaging', fields: ['exchangeName', 'exchangeType', 'queueName', 'routingKey', 'durable'] },
        { name: 'security', title: 'Security', fields: ['useTls'] },
        { name: 'data', title: 'Data', fields: ['messageFormat'] },
        { name: 'advanced', title: 'Advanced', fields: ['prefetchCount', 'heartbeat'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: 'localhost',
      port: 5672,
      vhost: '/',
      username: 'guest',
      password: '',
      exchangeName: '',
      exchangeType: 'direct',
      queueName: '',
      routingKey: '',
      durable: false,
      prefetchCount: 1,
      heartbeat: 60,
      useTls: false,
      messageFormat: 'json',
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: true,
      supportsPolling: true,
      supportsSubscription: true,
      supportsAuthentication: true,
      supportsEncryption: true,
      supportedDataTypes: ['json', 'text', 'binary'],
    };
  }
}
