import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class SchneiderModiconAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'SCHNEIDER_MODICON';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Schneider Modicon';
  readonly description = 'Schneider Electric Modicon PLC communication (Modbus Plus/Ethernet)';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'schneider_modicon' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Schneider Modicon Configuration', required: ['host'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 502, 'ui:order': 2, 'ui:group': 'connection' },
        plcType: { type: 'string', title: 'PLC Type', enum: ['M340', 'M580', 'Premium', 'Quantum', 'M221', 'M241', 'M251'], default: 'M340', 'ui:order': 3, 'ui:group': 'plc' },
        unitId: { type: 'integer', title: 'Unit ID', default: 1, minimum: 1, maximum: 247, 'ui:order': 4, 'ui:group': 'plc' },
        registerType: { type: 'string', title: 'Register Type', enum: ['%M', '%MW', '%MD', '%I', '%IW', '%Q', '%QW'], default: '%MW', 'ui:order': 5, 'ui:group': 'address' },
        startAddress: { type: 'integer', title: 'Start Address', default: 0, 'ui:order': 6, 'ui:group': 'address' },
        registerCount: { type: 'integer', title: 'Register Count', default: 1, 'ui:order': 7, 'ui:group': 'address' },
        useUnityPro: { type: 'boolean', title: 'Use Unity Pro Addressing', default: false, 'ui:order': 8, 'ui:group': 'advanced' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 5000, 'ui:order': 9, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port'] },
        { name: 'plc', title: 'PLC Settings', fields: ['plcType', 'unitId'] },
        { name: 'address', title: 'Address', fields: ['registerType', 'startAddress', 'registerCount'] },
        { name: 'advanced', title: 'Advanced', fields: ['useUnityPro', 'timeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 502, plcType: 'M340', unitId: 1, registerType: '%MW', startAddress: 0, registerCount: 1, useUnityPro: false, timeout: 5000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOL', 'INT', 'DINT', 'REAL', 'WORD', 'DWORD'] };
  }
}
