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
  [key: string]: unknown;
  connected: boolean;
  end: (force: boolean, options: Record<string, unknown>, callback: () => void) => void;
  subscribe: (topic: string, options: { qos: number }, callback: (err: Error | null) => void) => void;
  unsubscribe: (topic: string) => void;
  once: (event: string, handler: (topic: string, message: Buffer) => void) => void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'connect', handler: () => void): void;
  on(event: 'message', handler: (topic: string, message: Buffer) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
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
export class MqttAdapter extends BaseProtocolAdapter<MqttConfiguration> {
  readonly protocolCode = 'MQTT';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.MESSAGE_QUEUE;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'MQTT';
  readonly description = 'Message Queuing Telemetry Transport - Lightweight publish/subscribe messaging protocol';

  private clients = new Map<string, MqttClientData>();

  async connect(config: MqttConfiguration): Promise<ConnectionHandle> {
    const mqttConfig = config;

    // Dynamic import mqtt library
    const mqtt = await import('mqtt');

    const brokerUrl = mqttConfig.useTls
      ? `mqtts://${mqttConfig.brokerUrl}:${mqttConfig.port}`
      : `mqtt://${mqttConfig.brokerUrl}:${mqttConfig.port}`;

    // SENSOR-HIGH-075: validate the operator-supplied broker host before
    // connecting (dial by hostname to preserve TLS SNI). Rejects
    // metadata/loopback/RFC-1918 targets so a broker "connection test" cannot
    // become an internal port-scan oracle.
    await this.assertOutboundHostAllowed(mqttConfig.brokerUrl, mqttConfig.port);

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

  async testConnection(config: MqttConfiguration): Promise<ConnectionTestResult> {
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
            broker: clientData?.config.brokerUrl,
            topic: clientData?.config.topic,
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

      client.subscribe(config.topic, { qos: config.qos }, (err: Error | null) => {
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
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

   
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

    client.subscribe(config.topic, { qos: config.qos }, () => {
      // Subscription acknowledged
    });
    client.on('message', messageHandler);

    return {
      id: `sub_${handle.id}_${Date.now()}`,
       
      unsubscribe: async () => {
        isActive = false;
        client.unsubscribe(config.topic);
        client.removeListener('message', messageHandler);
      },
      isActive: () => isActive && client.connected,
    };
  }

  /**
   * ADR-047 §1, §8: an MQTT sensor publishes to the platform broker with the
   * principal it is issued after registration. The broker, port, topic,
   * client ID and credentials are the platform's, so none of them is typed
   * in: a configuration naming one is refused (a wizard-typed broker
   * credential never reached the broker anyway), and so is any payload format
   * but JSON, the one the sensor data route reads.
   */
  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const entries =
      typeof config === 'object' && config !== null ? Object.entries(config) : [];
    for (const [field, value] of entries) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (field === 'payloadFormat') {
        if (value !== 'json') {
          errors.push(
            this.validationError(field, 'An MQTT sensor publishes one JSON object per message'),
          );
        }
        continue;
      }
      errors.push(
        this.validationError(
          field,
          `${field} is not set on an MQTT sensor: the platform issues its broker connection after registration`,
        ),
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'MQTT',
      description:
        'The sensor publishes one JSON object per message to the platform broker with its own ' +
        'credential. The host, port, client ID, username, password and topic are issued after ' +
        'registration; each data channel names its value in the message.',
      properties: {},
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {};
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
          const parsed = JSON.parse(message.toString()) as Record<string, unknown>;
          if (config.dataMapping) {
            for (const [key, path] of Object.entries(config.dataMapping)) {
              values[key] = this.getNestedValue(parsed, path) as string | number | boolean | null;
            }
          } else {
            values = this.flattenObject(parsed) as Record<string, string | number | boolean | null>;
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
