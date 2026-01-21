import * as net from 'net';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class TcpSocketAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'TCP_SOCKET';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.NETWORK;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'TCP Socket';
  readonly description = 'Raw TCP socket communication for custom protocols';

  private sockets: Map<string, net.Socket> = new Map();

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const handle = this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = (config.timeout as number) || 5000;

      socket.setTimeout(timeout);
      socket.connect(config.port as number, config.host as string, () => {
        this.sockets.set(handle.id, socket);
        resolve(handle);
      });

      socket.on('error', (err) => reject(err));
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const socket = this.sockets.get(handle.id);
    if (socket) {
      socket.destroy();
      this.sockets.delete(handle.id);
    }
    this.removeConnectionHandle(handle.id);
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const handle = await this.connect(config);
      const latencyMs = Date.now() - startTime;
      await this.disconnect(handle);
      return { success: true, latencyMs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const socket = this.sockets.get(handle.id);
    if (!socket) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Read timeout')), 5000);
      socket.once('data', (data) => {
        clearTimeout(timeout);
        resolve({ timestamp: new Date(), values: { raw: data.toString() }, quality: 100, source: 'tcp_socket' });
      });
    });
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'Host is required'));
    if (!cfg.port || cfg.port < 1 || cfg.port > 65535) errors.push(this.validationError('port', 'Port must be 1-65535'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'TCP Socket Configuration', required: ['host', 'port'],
      properties: {
        host: { type: 'string', title: 'Host', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', minimum: 1, maximum: 65535, 'ui:order': 2, 'ui:group': 'connection' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 5000, 'ui:order': 3, 'ui:group': 'connection' },
        keepAlive: { type: 'boolean', title: 'Keep Alive', default: true, 'ui:order': 4, 'ui:group': 'options' },
        keepAliveDelay: { type: 'integer', title: 'Keep Alive Delay (ms)', default: 60000, 'ui:order': 5, 'ui:group': 'options' },
        delimiter: { type: 'string', title: 'Delimiter', description: 'Message delimiter (e.g., \\n, \\r\\n)', default: '\n', 'ui:order': 6, 'ui:group': 'parsing' },
        encoding: { type: 'string', title: 'Encoding', enum: ['utf8', 'ascii', 'hex', 'base64'], default: 'utf8', 'ui:order': 7, 'ui:group': 'parsing' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'timeout'] },
        { name: 'options', title: 'Options', fields: ['keepAlive', 'keepAliveDelay'] },
        { name: 'parsing', title: 'Data Parsing', fields: ['delimiter', 'encoding'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 0, timeout: 5000, keepAlive: true, keepAliveDelay: 60000, delimiter: '\n', encoding: 'utf8' };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['STRING', 'BINARY'] };
  }
}
