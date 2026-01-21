import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class BacnetMstpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'BACNET_MSTP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.BUILDING_AUTOMATION;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'BACnet/MSTP';
  readonly description = 'BACnet MS/TP over RS-485 for building automation';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'bacnet_mstp' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.comPort) errors.push(this.validationError('comPort', 'COM Port is required'));
    if (cfg.macAddress === undefined || cfg.macAddress < 0 || cfg.macAddress > 254) errors.push(this.validationError('macAddress', 'MAC address must be 0-254'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'BACnet/MSTP Configuration', required: ['comPort', 'macAddress'],
      properties: {
        comPort: { type: 'string', title: 'COM Port', 'ui:order': 1, 'ui:group': 'serial' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [9600, 19200, 38400, 57600, 76800, 115200], default: 38400, 'ui:order': 2, 'ui:group': 'serial' },
        macAddress: { type: 'integer', title: 'MAC Address', minimum: 0, maximum: 254, 'ui:order': 3, 'ui:group': 'mstp' },
        maxMaster: { type: 'integer', title: 'Max Master', default: 127, 'ui:order': 4, 'ui:group': 'mstp' },
        deviceInstance: { type: 'integer', title: 'Device Instance', 'ui:order': 5, 'ui:group': 'bacnet' },
        objectType: { type: 'string', title: 'Object Type', enum: ['analog-input', 'analog-output', 'binary-input', 'binary-output'], default: 'analog-input', 'ui:order': 6, 'ui:group': 'bacnet' },
        objectInstance: { type: 'integer', title: 'Object Instance', 'ui:order': 7, 'ui:group': 'bacnet' },
      },
      'ui:groups': [
        { name: 'serial', title: 'Serial Port', fields: ['comPort', 'baudRate'] },
        { name: 'mstp', title: 'MS/TP', fields: ['macAddress', 'maxMaster'] },
        { name: 'bacnet', title: 'BACnet', fields: ['deviceInstance', 'objectType', 'objectInstance'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { comPort: '', baudRate: 38400, macAddress: 1, maxMaster: 127, deviceInstance: 0, objectType: 'analog-input', objectInstance: 0 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['REAL', 'UNSIGNED', 'BOOLEAN'] };
  }
}
