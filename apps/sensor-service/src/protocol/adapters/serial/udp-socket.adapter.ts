import * as dgram from 'dgram';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class UdpSocketAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'UDP_SOCKET';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.NETWORK;
  readonly connectionType = ConnectionType.UDP;
  readonly displayName = 'UDP Socket';
  readonly description = 'Raw UDP socket communication for custom protocols';

  private sockets: Map<string, dgram.Socket> = new Map();

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const handle = this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const localPort = config.localPort as number;

      if (localPort) {
        socket.bind(localPort, () => {
          this.sockets.set(handle.id, socket);
          resolve(handle);
        });
      } else {
        socket.bind(() => {
          this.sockets.set(handle.id, socket);
          resolve(handle);
        });
      }

      socket.on('error', (err) => reject(err));
    });
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    const socket = this.sockets.get(handle.id);
    if (socket) {
      socket.close();
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
      socket.once('message', (msg, rinfo) => {
        clearTimeout(timeout);
        resolve({ timestamp: new Date(), values: { raw: msg.toString(), remoteAddress: rinfo.address, remotePort: rinfo.port }, quality: 100, source: 'udp_socket' });
      });
    });
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.remoteHost) errors.push(this.validationError('remoteHost', 'Remote host is required'));
    if (!cfg.remotePort || cfg.remotePort < 1 || cfg.remotePort > 65535) errors.push(this.validationError('remotePort', 'Remote port must be 1-65535'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'UDP Socket Configuration', required: ['remoteHost', 'remotePort'],
      properties: {
        remoteHost: { type: 'string', title: 'Remote Host', 'ui:order': 1, 'ui:group': 'connection' },
        remotePort: { type: 'integer', title: 'Remote Port', minimum: 1, maximum: 65535, 'ui:order': 2, 'ui:group': 'connection' },
        localPort: { type: 'integer', title: 'Local Port', description: 'Leave empty for auto-assign', minimum: 1, maximum: 65535, 'ui:order': 3, 'ui:group': 'connection' },
        broadcast: { type: 'boolean', title: 'Broadcast Mode', default: false, 'ui:order': 4, 'ui:group': 'options' },
        multicastGroup: { type: 'string', title: 'Multicast Group', 'ui:order': 5, 'ui:group': 'options' },
        ttl: { type: 'integer', title: 'TTL', default: 64, minimum: 1, maximum: 255, 'ui:order': 6, 'ui:group': 'options' },
        encoding: { type: 'string', title: 'Encoding', enum: ['utf8', 'ascii', 'hex', 'base64'], default: 'utf8', 'ui:order': 7, 'ui:group': 'parsing' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['remoteHost', 'remotePort', 'localPort'] },
        { name: 'options', title: 'Options', fields: ['broadcast', 'multicastGroup', 'ttl'] },
        { name: 'parsing', title: 'Data Parsing', fields: ['encoding'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { remoteHost: '', remotePort: 0, localPort: undefined, broadcast: false, ttl: 64, encoding: 'utf8' };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['STRING', 'BINARY'] };
  }
}
