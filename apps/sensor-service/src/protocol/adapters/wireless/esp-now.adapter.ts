import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class EspNowAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ESP_NOW';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.SHORT_RANGE;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'ESP-NOW';
  readonly description = 'ESP-NOW connectionless wireless protocol for ESP devices';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'esp_now' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.peerMacAddress) errors.push(this.validationError('peerMacAddress', 'Peer MAC Address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'ESP-NOW Configuration', required: ['peerMacAddress'],
      properties: {
        gatewayPort: { type: 'string', title: 'Gateway Serial Port', description: 'Serial port of ESP-NOW gateway', 'ui:placeholder': '/dev/ttyUSB0', 'ui:order': 1, 'ui:group': 'gateway' },
        gatewayBaudRate: { type: 'integer', title: 'Gateway Baud Rate', enum: [9600, 115200, 921600], default: 115200, 'ui:order': 2, 'ui:group': 'gateway' },
        gatewayMacAddress: { type: 'string', title: 'Gateway MAC Address', description: 'Format: AA:BB:CC:DD:EE:FF', 'ui:placeholder': 'AA:BB:CC:DD:EE:FF', 'ui:order': 3, 'ui:group': 'gateway' },
        peerMacAddress: { type: 'string', title: 'Peer MAC Address', description: 'Format: AA:BB:CC:DD:EE:FF', 'ui:placeholder': 'AA:BB:CC:DD:EE:FF', 'ui:order': 4, 'ui:group': 'peer' },
        channel: { type: 'integer', title: 'WiFi Channel', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], default: 1, 'ui:order': 5, 'ui:group': 'peer' },
        encryption: { type: 'boolean', title: 'Enable Encryption', default: false, 'ui:order': 6, 'ui:group': 'security' },
        pmk: { type: 'string', title: 'Primary Master Key', description: '16 bytes hex', 'ui:widget': 'password', 'ui:order': 7, 'ui:group': 'security' },
        lmk: { type: 'string', title: 'Local Master Key', description: '16 bytes hex', 'ui:widget': 'password', 'ui:order': 8, 'ui:group': 'security' },
        dataFormat: { type: 'string', title: 'Data Format', enum: ['JSON', 'Binary', 'Custom'], default: 'JSON', 'ui:order': 9, 'ui:group': 'data' },
        maxPacketSize: { type: 'integer', title: 'Max Packet Size', default: 250, maximum: 250, 'ui:order': 10, 'ui:group': 'data' },
      },
      'ui:groups': [
        { name: 'gateway', title: 'Gateway', fields: ['gatewayPort', 'gatewayBaudRate', 'gatewayMacAddress'] },
        { name: 'peer', title: 'Peer Device', fields: ['peerMacAddress', 'channel'] },
        { name: 'security', title: 'Security', fields: ['encryption', 'pmk', 'lmk'] },
        { name: 'data', title: 'Data Format', fields: ['dataFormat', 'maxPacketSize'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { gatewayPort: '', gatewayBaudRate: 115200, gatewayMacAddress: '', peerMacAddress: '', channel: 1, encryption: false, dataFormat: 'JSON', maxPacketSize: 250 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: false, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: true, supportedDataTypes: ['JSON', 'BINARY'] };
  }
}
