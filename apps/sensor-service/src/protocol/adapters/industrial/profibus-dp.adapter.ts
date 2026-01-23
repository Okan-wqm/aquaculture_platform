import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface ProfibusDpConfig {
  sensorId?: string;
  tenantId?: string;
  stationAddress?: number;
}

@Injectable()
export class ProfibusDpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'PROFIBUS_DP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.FIELDBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'PROFIBUS DP';
  readonly description = 'PROFIBUS Decentralized Peripherals for industrial fieldbus';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> { const cfg = config as ProfibusDpConfig; return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config); }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'profibus_dp' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as ProfibusDpConfig;
    const errors = [];
    if (cfg.stationAddress === undefined || cfg.stationAddress < 1 || cfg.stationAddress > 125) errors.push(this.validationError('stationAddress', 'Station address must be 1-125'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'PROFIBUS DP Configuration', required: ['stationAddress'],
      properties: {
        stationAddress: { type: 'integer', title: 'Station Address', minimum: 1, maximum: 125, 'ui:order': 1, 'ui:group': 'connection' },
        baudRate: { type: 'string', title: 'Baud Rate', enum: ['9.6k', '19.2k', '93.75k', '187.5k', '500k', '1.5M', '3M', '6M', '12M'], default: '1.5M', 'ui:order': 2, 'ui:group': 'connection' },
        gsdFile: { type: 'string', title: 'GSD File', description: 'Generic Station Description file', 'ui:order': 3, 'ui:group': 'config' },
        inputDataLength: { type: 'integer', title: 'Input Data Length (bytes)', maximum: 244, 'ui:order': 4, 'ui:group': 'config' },
        outputDataLength: { type: 'integer', title: 'Output Data Length (bytes)', maximum: 244, 'ui:order': 5, 'ui:group': 'config' },
        watchdogTime: { type: 'integer', title: 'Watchdog Time (ms)', default: 400, 'ui:order': 6, 'ui:group': 'timing' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['stationAddress', 'baudRate'] },
        { name: 'config', title: 'Configuration', fields: ['gsdFile', 'inputDataLength', 'outputDataLength'] },
        { name: 'timing', title: 'Timing', fields: ['watchdogTime'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> { return { stationAddress: 1, baudRate: '1.5M', inputDataLength: 0, outputDataLength: 0, watchdogTime: 400 }; }
  getCapabilities(): ProtocolCapabilities { return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BYTE', 'WORD', 'DWORD'] }; }
}
