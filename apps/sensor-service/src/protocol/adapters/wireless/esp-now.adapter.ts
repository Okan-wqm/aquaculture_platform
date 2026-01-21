import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface EspNowConfig {
  sensorId?: string;
  tenantId?: string;
  peerMacAddress?: string;
}

@Injectable()
export class EspNowAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ESP_NOW';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.SHORT_RANGE;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'ESP-NOW';
  readonly description = 'ESP-NOW connectionless wireless protocol for ESP devices';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as EspNowConfig;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'esp_now' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as EspNowConfig;
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
