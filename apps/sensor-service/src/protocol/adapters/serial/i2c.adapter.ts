import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class I2cAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'I2C';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.BUS;
  readonly connectionType = ConnectionType.I2C;
  readonly displayName = 'I²C';
  readonly description = 'I²C (Inter-Integrated Circuit) two-wire serial bus';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'i2c' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (cfg.busNumber === undefined || cfg.busNumber < 0) errors.push(this.validationError('busNumber', 'Bus number is required'));
    if (cfg.deviceAddress === undefined || cfg.deviceAddress < 0x03 || cfg.deviceAddress > 0x77) errors.push(this.validationError('deviceAddress', 'Device address must be 0x03-0x77'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'I²C Configuration', required: ['busNumber', 'deviceAddress'],
      properties: {
        busNumber: { type: 'integer', title: 'Bus Number', description: 'e.g., 1 for /dev/i2c-1', minimum: 0, 'ui:order': 1, 'ui:group': 'bus' },
        deviceAddress: { type: 'string', title: 'Device Address', description: 'Hex format (e.g., 0x48)', 'ui:placeholder': '0x48', 'ui:order': 2, 'ui:group': 'bus' },
        addressMode: { type: 'string', title: 'Address Mode', enum: ['7-bit', '10-bit'], default: '7-bit', 'ui:order': 3, 'ui:group': 'bus' },
        speed: { type: 'string', title: 'Speed Mode', enum: ['Standard (100kHz)', 'Fast (400kHz)', 'Fast+ (1MHz)', 'High (3.4MHz)'], default: 'Standard (100kHz)', 'ui:order': 4, 'ui:group': 'bus' },
        registerAddress: { type: 'string', title: 'Register Address', description: 'Hex format (e.g., 0x00)', 'ui:placeholder': '0x00', 'ui:order': 5, 'ui:group': 'read' },
        readLength: { type: 'integer', title: 'Read Length (bytes)', default: 1, minimum: 1, maximum: 32, 'ui:order': 6, 'ui:group': 'read' },
        writeBeforeRead: { type: 'boolean', title: 'Write Register Before Read', default: true, 'ui:order': 7, 'ui:group': 'read' },
      },
      'ui:groups': [
        { name: 'bus', title: 'Bus Settings', fields: ['busNumber', 'deviceAddress', 'addressMode', 'speed'] },
        { name: 'read', title: 'Read Configuration', fields: ['registerAddress', 'readLength', 'writeBeforeRead'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { busNumber: 1, deviceAddress: '0x48', addressMode: '7-bit', speed: 'Standard (100kHz)', registerAddress: '0x00', readLength: 2, writeBeforeRead: true };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BYTE', 'WORD', 'BLOCK'] };
  }
}
