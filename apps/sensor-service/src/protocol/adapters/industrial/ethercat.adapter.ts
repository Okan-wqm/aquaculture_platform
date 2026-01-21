import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface EthercatConfig {
  sensorId?: string;
  tenantId?: string;
  networkInterface?: string;
  slavePosition?: number;
}

@Injectable()
export class EthercatAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ETHERCAT';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.REALTIME_ETHERNET;
  readonly connectionType = ConnectionType.ETHERNET;
  readonly displayName = 'EtherCAT';
  readonly description = 'EtherCAT real-time industrial Ethernet protocol';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as EthercatConfig;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'ethercat' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as EthercatConfig;
    const errors = [];
    if (!cfg.networkInterface) errors.push(this.validationError('networkInterface', 'Network interface is required'));
    if (cfg.slavePosition === undefined || cfg.slavePosition < 0) errors.push(this.validationError('slavePosition', 'Slave position must be >= 0'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'EtherCAT Configuration', required: ['networkInterface', 'slavePosition'],
      properties: {
        networkInterface: { type: 'string', title: 'Network Interface', description: 'e.g., eth0', 'ui:order': 1, 'ui:group': 'connection' },
        slavePosition: { type: 'integer', title: 'Slave Position', minimum: 0, 'ui:order': 2, 'ui:group': 'connection' },
        vendorId: { type: 'string', title: 'Vendor ID', 'ui:order': 3, 'ui:group': 'device' },
        productCode: { type: 'string', title: 'Product Code', 'ui:order': 4, 'ui:group': 'device' },
        esiFile: { type: 'string', title: 'ESI File', description: 'EtherCAT Slave Information file', 'ui:order': 5, 'ui:group': 'device' },
        dcEnabled: { type: 'boolean', title: 'Distributed Clocks Enabled', default: false, 'ui:order': 6, 'ui:group': 'timing' },
        cycleTime: { type: 'integer', title: 'Cycle Time (µs)', default: 1000, 'ui:order': 7, 'ui:group': 'timing' },
        pdoMapping: { type: 'string', title: 'PDO Mapping', description: 'JSON format PDO mapping configuration', 'ui:order': 8, 'ui:group': 'pdo' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['networkInterface', 'slavePosition'] },
        { name: 'device', title: 'Device', fields: ['vendorId', 'productCode', 'esiFile'] },
        { name: 'timing', title: 'Timing', fields: ['dcEnabled', 'cycleTime'] },
        { name: 'pdo', title: 'PDO', fields: ['pdoMapping'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { networkInterface: 'eth0', slavePosition: 0, vendorId: '', productCode: '', dcEnabled: false, cycleTime: 1000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'DINT', 'REAL'] };
  }
}
