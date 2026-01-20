import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

export interface ProfinetConfiguration {
  deviceName: string;
  host: string;
  subnetMask: string;
  slotNumber: number;
  subslotNumber: number;
  cycleTime: number;
  watchdogTimeout: number;
  gsdmlFile?: string;
  inputDataSize: number;
  outputDataSize: number;
}

@Injectable()
export class ProfinetAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'PROFINET';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.ETHERNET_INDUSTRIAL;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'PROFINET';
  readonly description = 'PROFINET industrial Ethernet standard for automation';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const handle = this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
    return handle;
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    return { success: true, latencyMs: 0 };
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    return { timestamp: new Date(), values: {}, quality: 100, source: 'profinet' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as Partial<ProfinetConfiguration>;
    const errors = [];
    if (!cfg.deviceName) errors.push(this.validationError('deviceName', 'Device name is required'));
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'PROFINET Configuration',
      required: ['deviceName', 'host'],
      properties: {
        deviceName: { type: 'string', title: 'Device Name', 'ui:order': 1, 'ui:group': 'connection' },
        host: { type: 'string', title: 'IP Address', 'ui:order': 2, 'ui:group': 'connection' },
        subnetMask: { type: 'string', title: 'Subnet Mask', default: '255.255.255.0', 'ui:order': 3, 'ui:group': 'connection' },
        slotNumber: { type: 'integer', title: 'Slot Number', default: 0, 'ui:order': 4, 'ui:group': 'io' },
        subslotNumber: { type: 'integer', title: 'Subslot Number', default: 1, 'ui:order': 5, 'ui:group': 'io' },
        cycleTime: { type: 'integer', title: 'Cycle Time (ms)', default: 4, 'ui:order': 6, 'ui:group': 'timing' },
        watchdogTimeout: { type: 'integer', title: 'Watchdog Timeout', default: 100, 'ui:order': 7, 'ui:group': 'timing' },
        inputDataSize: { type: 'integer', title: 'Input Data Size (bytes)', 'ui:order': 8, 'ui:group': 'io' },
        outputDataSize: { type: 'integer', title: 'Output Data Size (bytes)', 'ui:order': 9, 'ui:group': 'io' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['deviceName', 'host', 'subnetMask'] },
        { name: 'io', title: 'I/O Configuration', fields: ['slotNumber', 'subslotNumber', 'inputDataSize', 'outputDataSize'] },
        { name: 'timing', title: 'Timing', fields: ['cycleTime', 'watchdogTimeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { deviceName: '', host: '', subnetMask: '255.255.255.0', slotNumber: 0, subslotNumber: 1, cycleTime: 4, watchdogTimeout: 100, inputDataSize: 0, outputDataSize: 0 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: false, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BYTE', 'WORD', 'DWORD', 'REAL'] };
  }
}
