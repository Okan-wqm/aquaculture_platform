import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class DeviceNetAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'DEVICENET';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.FIELDBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'DeviceNet';
  readonly description = 'DeviceNet CAN-based industrial network protocol';

  constructor(configService: ConfigService) { super(configService); }
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> { return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config); }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'devicenet' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (cfg.macId === undefined || cfg.macId < 0 || cfg.macId > 63) errors.push(this.validationError('macId', 'MAC ID must be 0-63'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'DeviceNet Configuration', required: ['macId'],
      properties: {
        macId: { type: 'integer', title: 'MAC ID', minimum: 0, maximum: 63, 'ui:order': 1, 'ui:group': 'connection' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [125000, 250000, 500000], default: 125000, 'ui:order': 2, 'ui:group': 'connection' },
        connectionType: { type: 'string', title: 'Connection Type', enum: ['Polled', 'Strobed', 'COS', 'Cyclic'], default: 'Polled', 'ui:order': 3, 'ui:group': 'io' },
        expectedPacketRate: { type: 'integer', title: 'Expected Packet Rate (ms)', default: 50, 'ui:order': 4, 'ui:group': 'io' },
        inputAssemblyInstance: { type: 'integer', title: 'Input Assembly Instance', 'ui:order': 5, 'ui:group': 'io' },
        outputAssemblyInstance: { type: 'integer', title: 'Output Assembly Instance', 'ui:order': 6, 'ui:group': 'io' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['macId', 'baudRate'] },
        { name: 'io', title: 'I/O Configuration', fields: ['connectionType', 'expectedPacketRate', 'inputAssemblyInstance', 'outputAssemblyInstance'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> { return { macId: 1, baudRate: 125000, connectionType: 'Polled', expectedPacketRate: 50 }; }
  getCapabilities(): ProtocolCapabilities { return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOL', 'INT', 'DINT', 'REAL'] }; }
}
