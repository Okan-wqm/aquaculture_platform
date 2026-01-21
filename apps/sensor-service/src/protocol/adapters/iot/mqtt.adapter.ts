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

/**
 * MQTT Protocol Configuration
 */
export interface MqttConfiguration {
  sensorId?: string;
  tenantId?: string;
  brokerUrl: string;
  port: number;
  topic: string;
  qos: 0 | 1 | 2;
  clientId?: string;
  username?: string;
  password?: string;
  useTls: boolean;
  cleanSession: boolean;
  keepAlive: number;
  reconnectPeriod: number;
  connectTimeout: number;
  // TLS options
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  rejectUnauthorized: boolean;
  // LWT (Last Will and Testament)
  willTopic?: string;
  willPayload?: string;
  willQos?: 0 | 1 | 2;
  willRetain?: boolean;
  // Data parsing
  payloadFormat: 'json' | 'csv' | 'text' | 'binary';
  dataMapping?: Record<string, string>;
}

interface MqttClientInstance {
  connected: boolean;
  end: (force: boolean, options: Record<string, unknown>, callback: () => void) => void;
  subscribe: (topic: string, options: { qos: number }, callback: (err: Error | null) => void) => void;
  unsubscribe: (topic: string) => void;
  once: (event: string, handler: (topic: string, message: Buffer) => void) => void;
  on: (event: string, handler: (topic: string, message: Buffer) => void) => void;
  removeListener: (event: string, handler: (topic: string, message: Buffer) => void) => void;
}

interface MqttClientData {
  client: MqttClientInstance;
  config: MqttConfiguration;
}

interface MqttConnectOptions {
  clientId: string;
  clean: boolean;
  keepalive: number;
  reconnectPeriod: number;
  connectTimeout: number;
  username?: string;
  password?: string;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  will?: {
    topic: string;
    payload: string;
    qos: 0 | 1 | 2;
    retain: boolean;
  };
}

@Injectable()
export class MqttAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'MQTT';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.MESSAGE_QUEUE;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'MQTT';
  readonly description = 'Message Queuing Telemetry Transport - Lightweight publish/subscribe messaging protocol';

  private clients = new Map<string, MqttClientData>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const mqttConfig = config as unknown as MqttConfiguration;

    // Dynamic import mqtt library
    const mqtt = await import('mqtt');

    const brokerUrl = mqttConfig.useTls
      ? `mqtts://${mqttConfig.brokerUrl}:${mqttConfig.port}`
      : `mqtt://${mqttConfig.brokerUrl}:${mqttConfig.port}`;

    const options: MqttConnectOptions = {
      clientId: mqttConfig.clientId || `aqua_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      clean: mqttConfig.cleanSession,
      keepalive: mqttConfig.keepAlive,
      reconnectPeriod: mqttConfig.reconnectPeriod,
      connectTimeout: mqttConfig.connectTimeout,
    };

    if (mqttConfig.username) {
      options.username = mqttConfig.username;
      options.password = mqttConfig.password;
    }

    if (mqttConfig.useTls) {
      options.rejectUnauthorized = mqttConfig.rejectUnauthorized;
      if (mqttConfig.caCert) options.ca = mqttConfig.caCert;
      if (mqttConfig.clientCert) options.cert = mqttConfig.clientCert;
      if (mqttConfig.clientKey) options.key = mqttConfig.clientKey;
    }

    if (mqttConfig.willTopic) {
      options.will = {
        topic: mqttConfig.willTopic,
        payload: mqttConfig.willPayload || '',
        qos: mqttConfig.willQos || 0,
        retain: mqttConfig.willRetain || false,
      };
    }

    return new Promise((resolve, reject) => {
      const client = mqtt.connect(brokerUrl, options) as unknown as MqttClientInstance;

      const timeout = setTimeout(() => {
        client.end(true, {}, () => {
          // Connection ended
        });
        reject(new Error('Connection timeout'));
      }, mqttConfig.connectTimeout);

      client.on('connect', () => {
        clearTimeout(timeout);
        const handle = this.createConnectionHandle(
          mqttConfig.sensorId ?? 'unknown',
          mqttConfig.tenantId ?? 'unknown',
          { brokerUrl, topic: mqttConfig.topic }
        );
        this.clients.set(handle.id, { client, config: mqttConfig });
        this.logConnectionEvent('connect', handle, { brokerUrl });
        resolve(handle);
      });

      client.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const clientData = this.clients.get(handle.id);
    if (clientData) {
      await new Promise<void>((resolve) => {
        clientData.client.end(false, {}, () => {
          resolve();
        });
      });
      this.clients.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  isConnected(handle: ConnectionHandle): boolean {
    const clientData = this.clients.get(handle.id);
    return clientData?.client?.connected || false;
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.withTimeout(
        this.connect(config),
        (config.connectTimeout as number) || 10000,
        'Connection test timeout'
      );

      const latencyMs = Date.now() - startTime;
      const clientData = this.clients.get(handle.id);

      // Try to receive a sample message
      let sampleData: SensorReadingData | undefined;

      try {
        sampleData = await this.withTimeout(
          this.readData(handle),
          5000,
          'No data received'
        );
      } catch {
        // Sample data is optional
      }

      return {
        success: true,
        latencyMs,
        sampleData,
        diagnostics: {
          connectionTimeMs: latencyMs,
          deviceInfo: {
            broker: clientData.config.brokerUrl,
            topic: clientData.config.topic,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      if (handle) {
        await this.disconnect(handle);
      }
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const clientData = this.clients.get(handle.id);
    if (!clientData) {
      throw new Error('Connection not found');
    }

    const { client, config } = clientData;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Read timeout'));
      }, 30000);

      client.subscribe(config.topic, { qos: config.qos }, (err: Error) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      client.once('message', (topic: string, message: Buffer) => {
        clearTimeout(timeout);
        client.unsubscribe(config.topic);

        try {
          const data = this.parsePayload(message, config);
          this.updateLastActivity(handle);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribeToData(
    handle: ConnectionHandle,
    onData: DataCallback,
    onError?: ErrorCallback
  ): Promise<DataSubscription> {
    const clientData = this.clients.get(handle.id);
    if (!clientData) {
      throw new Error('Connection not found');
    }

    const { client, config } = clientData;
    let isActive = true;

    const messageHandler = (topic: string, message: Buffer): void => {
      if (topic === config.topic || this.topicMatches(config.topic, topic)) {
        try {
          const data = this.parsePayload(message, config);
          this.updateLastActivity(handle);
          onData(data);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    client.subscribe(config.topic, { qos: config.qos });
    client.on('message', messageHandler);

    return {
      id: `sub_${handle.id}_${Date.now()}`,
      // eslint-disable-next-line @typescript-eslint/require-await
      unsubscribe: async () => {
        isActive = false;
        client.unsubscribe(config.topic);
        client.removeListener('message', messageHandler);
      },
      isActive: () => isActive && client.connected,
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<MqttConfiguration>;

    // Required fields
    if (!cfg.brokerUrl) {
      errors.push(this.validationError('brokerUrl', 'Broker URL is required'));
    } else if (!this.isValidUrl(`mqtt://${cfg.brokerUrl}`) && !this.isValidIpAddress(cfg.brokerUrl)) {
      errors.push(this.validationError('brokerUrl', 'Invalid broker URL or IP address'));
    }

    if (!cfg.topic) {
      errors.push(this.validationError('topic', 'Topic is required'));
    } else if (cfg.topic.length > 65535) {
      errors.push(this.validationError('topic', 'Topic too long (max 65535 characters)'));
    }

    if (cfg.port !== undefined && !this.isValidPort(cfg.port)) {
      errors.push(this.validationError('port', 'Port must be between 1 and 65535'));
    }

    if (cfg.qos !== undefined && ![0, 1, 2].includes(cfg.qos)) {
      errors.push(this.validationError('qos', 'QoS must be 0, 1, or 2'));
    }

    if (cfg.keepAlive !== undefined && (cfg.keepAlive < 0 || cfg.keepAlive > 65535)) {
      errors.push(this.validationError('keepAlive', 'Keep-alive must be between 0 and 65535 seconds'));
    }

    // Warnings
    if (!cfg.useTls) {
      warnings.push(this.validationWarning('useTls', 'Connection is not encrypted. Consider using TLS.'));
    }

    if (!cfg.username && !cfg.clientCert) {
      warnings.push(this.validationWarning('username', 'No authentication configured'));
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'MQTT Configuration',
      description: 'Configure MQTT broker connection parameters',
      required: ['brokerUrl', 'topic'],
      properties: {
        brokerUrl: {
          type: 'string',
          title: 'Broker URL',
          description: 'MQTT broker hostname or IP address',
          'ui:placeholder': 'broker.example.com',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'MQTT broker port (1883 for TCP, 8883 for TLS)',
          default: 1883,
          minimum: 1,
          maximum: 65535,
          'ui:order': 2,
          'ui:group': 'connection',
        },
        topic: {
          type: 'string',
          title: 'Topic',
          description: 'MQTT topic to subscribe (supports wildcards + and #)',
          'ui:placeholder': 'sensors/temperature/#',
          'ui:order': 3,
          'ui:group': 'connection',
        },
        qos: {
          type: 'integer',
          title: 'QoS Level',
          description: 'Quality of Service: 0=At most once, 1=At least once, 2=Exactly once',
          enum: [0, 1, 2],
          enumNames: ['0 - At most once', '1 - At least once', '2 - Exactly once'],
          default: 1,
          'ui:order': 4,
          'ui:group': 'connection',
        },
        clientId: {
          type: 'string',
          title: 'Client ID',
          description: 'Unique client identifier (auto-generated if empty)',
          'ui:placeholder': 'Leave empty for auto-generated',
          'ui:order': 5,
          'ui:group': 'connection',
        },
        username: {
          type: 'string',
          title: 'Username',
          description: 'Authentication username',
          'ui:order': 6,
          'ui:group': 'authentication',
        },
        password: {
          type: 'string',
          title: 'Password',
          description: 'Authentication password',
          format: 'password',
          'ui:order': 7,
          'ui:group': 'authentication',
        },
        useTls: {
          type: 'boolean',
          title: 'Use TLS/SSL',
          description: 'Enable encrypted connection',
          default: false,
          'ui:order': 8,
          'ui:group': 'security',
        },
        rejectUnauthorized: {
          type: 'boolean',
          title: 'Verify Certificate',
          description: 'Reject connections with invalid certificates',
          default: true,
          'ui:order': 9,
          'ui:group': 'security',
        },
        caCert: {
          type: 'string',
          title: 'CA Certificate',
          description: 'Certificate Authority certificate (PEM format)',
          'ui:widget': 'textarea',
          'ui:order': 10,
          'ui:group': 'security',
        },
        clientCert: {
          type: 'string',
          title: 'Client Certificate',
          description: 'Client certificate for mutual TLS (PEM format)',
          'ui:widget': 'textarea',
          'ui:order': 11,
          'ui:group': 'security',
        },
        clientKey: {
          type: 'string',
          title: 'Client Key',
          description: 'Client private key (PEM format)',
          'ui:widget': 'textarea',
          'ui:order': 12,
          'ui:group': 'security',
        },
        cleanSession: {
          type: 'boolean',
          title: 'Clean Session',
          description: 'Start with a clean session (no persistent subscriptions)',
          default: true,
          'ui:order': 13,
          'ui:group': 'advanced',
        },
        keepAlive: {
          type: 'integer',
          title: 'Keep Alive (seconds)',
          description: 'Ping interval to keep connection alive',
          default: 60,
          minimum: 0,
          maximum: 65535,
          'ui:order': 14,
          'ui:group': 'advanced',
        },
        reconnectPeriod: {
          type: 'integer',
          title: 'Reconnect Period (ms)',
          description: 'Time between reconnection attempts',
          default: 1000,
          minimum: 0,
          'ui:order': 15,
          'ui:group': 'advanced',
        },
        connectTimeout: {
          type: 'integer',
          title: 'Connect Timeout (ms)',
          description: 'Connection timeout',
          default: 30000,
          minimum: 1000,
          'ui:order': 16,
          'ui:group': 'advanced',
        },
        payloadFormat: {
          type: 'string',
          title: 'Payload Format',
          description: 'Format of incoming messages',
          enum: ['json', 'csv', 'text', 'binary'],
          enumNames: ['JSON', 'CSV', 'Plain Text', 'Binary'],
          default: 'json',
          'ui:order': 17,
          'ui:group': 'data',
        },
        willTopic: {
          type: 'string',
          title: 'LWT Topic',
          description: 'Last Will and Testament topic',
          'ui:order': 18,
          'ui:group': 'lwt',
        },
        willPayload: {
          type: 'string',
          title: 'LWT Payload',
          description: 'Message to publish when connection is lost',
          'ui:order': 19,
          'ui:group': 'lwt',
        },
        willQos: {
          type: 'integer',
          title: 'LWT QoS',
          enum: [0, 1, 2],
          default: 0,
          'ui:order': 20,
          'ui:group': 'lwt',
        },
        willRetain: {
          type: 'boolean',
          title: 'LWT Retain',
          default: false,
          'ui:order': 21,
          'ui:group': 'lwt',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', description: 'Basic connection settings', fields: ['brokerUrl', 'port', 'topic', 'qos', 'clientId'] },
        { name: 'authentication', title: 'Authentication', description: 'Credentials', fields: ['username', 'password'] },
        { name: 'security', title: 'Security', description: 'TLS/SSL settings', fields: ['useTls', 'rejectUnauthorized', 'caCert', 'clientCert', 'clientKey'] },
        { name: 'data', title: 'Data Format', description: 'Payload parsing', fields: ['payloadFormat'] },
        { name: 'advanced', title: 'Advanced', description: 'Advanced settings', fields: ['cleanSession', 'keepAlive', 'reconnectPeriod', 'connectTimeout'] },
        { name: 'lwt', title: 'Last Will', description: 'Last Will and Testament', fields: ['willTopic', 'willPayload', 'willQos', 'willRetain'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      brokerUrl: '',
      port: 1883,
      topic: '',
      qos: 1,
      clientId: '',
      username: '',
      password: '',
      useTls: false,
      rejectUnauthorized: true,
      cleanSession: true,
      keepAlive: 60,
      reconnectPeriod: 1000,
      connectTimeout: 30000,
      payloadFormat: 'json',
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: true,
      supportsPolling: false,
      supportsSubscription: true,
      supportsAuthentication: true,
      supportsEncryption: true,
      supportedDataTypes: ['json', 'csv', 'text', 'binary'],
      minimumPollingIntervalMs: 100,
    };
  }

  private parsePayload(message: Buffer, config: MqttConfiguration): SensorReadingData {
    const timestamp = new Date();
    let values: Record<string, number | string | boolean | null> = {};

    switch (config.payloadFormat) {
      case 'json':
        try {
          const parsed = JSON.parse(message.toString());
          if (config.dataMapping) {
            for (const [key, path] of Object.entries(config.dataMapping)) {
              values[key] = this.getNestedValue(parsed, path);
            }
          } else {
            values = this.flattenObject(parsed);
          }
        } catch {
          values = { raw: message.toString() };
        }
        break;

      case 'csv': {
        const parts = message.toString().split(',');
        parts.forEach((part, index) => {
          const num = parseFloat(part.trim());
          values[`value_${index}`] = isNaN(num) ? part.trim() : num;
        });
        break;
      }

      case 'text':
        values = { value: message.toString() };
        break;

      case 'binary':
        values = { hex: message.toString('hex') };
        break;
    }

    return {
      timestamp,
      values,
      quality: 100,
      source: 'mqtt',
    };
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((o: unknown, k: string) => (o as Record<string, unknown>)?.[k], obj);
  }

  private flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value as Record<string, unknown>, newKey));
      } else {
        result[newKey] = value;
      }
    }
    return result;
  }

  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] === '+') continue;
      if (patternParts[i] !== topicParts[i]) return false;
    }

    return patternParts.length === topicParts.length;
  }
}
