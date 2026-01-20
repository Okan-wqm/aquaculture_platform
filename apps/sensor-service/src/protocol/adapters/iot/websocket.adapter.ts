import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';

export interface WebSocketConfiguration {
  url: string;
  subprotocol?: string;
  headers?: Record<string, string>;
  // Authentication
  authType: 'none' | 'bearer' | 'query';
  bearerToken?: string;
  authQueryParam?: string;
  authQueryValue?: string;
  // Connection
  pingInterval: number;
  pongTimeout: number;
  reconnect: boolean;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  // Data
  messageFormat: 'json' | 'text' | 'binary';
  dataPath?: string;
  subscribeMessage?: string;
}

@Injectable()
export class WebSocketAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'WEBSOCKET';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.REALTIME;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'WebSocket';
  readonly description = 'WebSocket protocol for real-time bidirectional communication';

  private sockets = new Map<string, any>();

  constructor(configService: ConfigService) {
    super(configService);
  }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const wsConfig = config as unknown as WebSocketConfiguration;
    const WebSocket = (await import('ws')).default;

    let url = wsConfig.url;
    if (wsConfig.authType === 'query' && wsConfig.authQueryParam && wsConfig.authQueryValue) {
      const urlObj = new URL(url);
      urlObj.searchParams.set(wsConfig.authQueryParam, wsConfig.authQueryValue);
      url = urlObj.toString();
    }

    const options: any = {};
    if (wsConfig.headers) {
      options.headers = { ...wsConfig.headers };
    }
    if (wsConfig.authType === 'bearer' && wsConfig.bearerToken) {
      options.headers = options.headers || {};
      options.headers['Authorization'] = `Bearer ${wsConfig.bearerToken}`;
    }
    if (wsConfig.subprotocol) {
      options.protocol = wsConfig.subprotocol;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      let pingInterval: NodeJS.Timeout | null = null;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, 30000);

      ws.on('open', () => {
        clearTimeout(timeout);

        const handle = this.createConnectionHandle(
          config.sensorId as string || 'unknown',
          config.tenantId as string || 'unknown',
          { url: wsConfig.url }
        );

        // Setup ping/pong
        if (wsConfig.pingInterval > 0) {
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.ping();
            }
          }, wsConfig.pingInterval);
        }

        this.sockets.set(handle.id, { ws, config: wsConfig, pingInterval });

        // Send subscribe message if configured
        if (wsConfig.subscribeMessage) {
          ws.send(wsConfig.subscribeMessage);
        }

        this.logConnectionEvent('connect', handle, { url: wsConfig.url });
        resolve(handle);
      });

      ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const socketData = this.sockets.get(handle.id);
    if (socketData) {
      if (socketData.pingInterval) {
        clearInterval(socketData.pingInterval);
      }
      socketData.ws.close();
      this.sockets.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  isConnected(handle: ConnectionHandle): boolean {
    const socketData = this.sockets.get(handle.id);
    const WebSocket = require('ws');
    return socketData?.ws?.readyState === WebSocket.OPEN;
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.withTimeout(this.connect(config), 30000, 'Connection timeout');
      const latencyMs = Date.now() - startTime;

      let sampleData: SensorReadingData | undefined;
      try {
        sampleData = await this.withTimeout(this.readData(handle), 5000, 'No data received');
      } catch {
        // Optional
      }

      return {
        success: true,
        latencyMs,
        sampleData,
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
    const socketData = this.sockets.get(handle.id);
    if (!socketData) throw new Error('Connection not found');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Read timeout')), 30000);

      socketData.ws.once('message', (data: Buffer) => {
        clearTimeout(timeout);
        try {
          const parsed = this.parseMessage(data, socketData.config);
          this.updateLastActivity(handle);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async subscribeToData(
    handle: ConnectionHandle,
    onData: DataCallback,
    onError?: ErrorCallback
  ): Promise<DataSubscription> {
    const socketData = this.sockets.get(handle.id);
    if (!socketData) throw new Error('Connection not found');

    let isActive = true;
    const messageHandler = (data: Buffer) => {
      try {
        const parsed = this.parseMessage(data, socketData.config);
        this.updateLastActivity(handle);
        onData(parsed);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socketData.ws.on('message', messageHandler);

    return {
      id: `sub_${handle.id}_${Date.now()}`,
      unsubscribe: async () => {
        isActive = false;
        socketData.ws.removeListener('message', messageHandler);
      },
      isActive: () => isActive && this.isConnected(handle),
    };
  }

  private parseMessage(data: Buffer, config: WebSocketConfiguration): SensorReadingData {
    const timestamp = new Date();
    let values: Record<string, number | string | boolean | null> = {};

    switch (config.messageFormat) {
      case 'json':
        try {
          const parsed = JSON.parse(data.toString());
          if (config.dataPath) {
            const value = config.dataPath.split('.').reduce((o, k) => o?.[k], parsed);
            values = typeof value === 'object' ? value : { value };
          } else {
            values = parsed;
          }
        } catch {
          values = { raw: data.toString() };
        }
        break;
      case 'text':
        values = { value: data.toString() };
        break;
      case 'binary':
        values = { hex: data.toString('hex') };
        break;
    }

    return { timestamp, values, quality: 100, source: 'websocket' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<WebSocketConfiguration>;

    if (!cfg.url) {
      errors.push(this.validationError('url', 'WebSocket URL is required'));
    } else if (!cfg.url.startsWith('ws://') && !cfg.url.startsWith('wss://')) {
      errors.push(this.validationError('url', 'URL must start with ws:// or wss://'));
    }

    if (cfg.url?.startsWith('ws://')) {
      warnings.push(this.validationWarning('url', 'Using unencrypted WebSocket. Consider using wss://'));
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'WebSocket Configuration',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          title: 'WebSocket URL',
          description: 'ws:// or wss:// URL',
          'ui:placeholder': 'wss://sensor.example.com/ws',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        subprotocol: {
          type: 'string',
          title: 'Subprotocol',
          'ui:order': 2,
          'ui:group': 'connection',
        },
        authType: {
          type: 'string',
          title: 'Authentication',
          enum: ['none', 'bearer', 'query'],
          enumNames: ['None', 'Bearer Token', 'Query Parameter'],
          default: 'none',
          'ui:order': 3,
          'ui:group': 'authentication',
        },
        bearerToken: {
          type: 'string',
          title: 'Bearer Token',
          format: 'password',
          'ui:order': 4,
          'ui:group': 'authentication',
        },
        authQueryParam: {
          type: 'string',
          title: 'Auth Query Parameter',
          'ui:placeholder': 'token',
          'ui:order': 5,
          'ui:group': 'authentication',
        },
        authQueryValue: {
          type: 'string',
          title: 'Auth Query Value',
          format: 'password',
          'ui:order': 6,
          'ui:group': 'authentication',
        },
        pingInterval: {
          type: 'integer',
          title: 'Ping Interval (ms)',
          default: 25000,
          'ui:order': 7,
          'ui:group': 'advanced',
        },
        pongTimeout: {
          type: 'integer',
          title: 'Pong Timeout (ms)',
          default: 5000,
          'ui:order': 8,
          'ui:group': 'advanced',
        },
        reconnect: {
          type: 'boolean',
          title: 'Auto Reconnect',
          default: true,
          'ui:order': 9,
          'ui:group': 'advanced',
        },
        messageFormat: {
          type: 'string',
          title: 'Message Format',
          enum: ['json', 'text', 'binary'],
          default: 'json',
          'ui:order': 10,
          'ui:group': 'data',
        },
        dataPath: {
          type: 'string',
          title: 'Data Path',
          description: 'JSON path to sensor data',
          'ui:placeholder': 'data.readings',
          'ui:order': 11,
          'ui:group': 'data',
        },
        subscribeMessage: {
          type: 'string',
          title: 'Subscribe Message',
          description: 'Message to send on connect',
          'ui:widget': 'textarea',
          'ui:order': 12,
          'ui:group': 'data',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['url', 'subprotocol'] },
        { name: 'authentication', title: 'Authentication', fields: ['authType', 'bearerToken', 'authQueryParam', 'authQueryValue'] },
        { name: 'data', title: 'Data', fields: ['messageFormat', 'dataPath', 'subscribeMessage'] },
        { name: 'advanced', title: 'Advanced', fields: ['pingInterval', 'pongTimeout', 'reconnect'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      url: '',
      authType: 'none',
      pingInterval: 25000,
      pongTimeout: 5000,
      reconnect: true,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      messageFormat: 'json',
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
      supportedDataTypes: ['json', 'text', 'binary'],
    };
  }
}
