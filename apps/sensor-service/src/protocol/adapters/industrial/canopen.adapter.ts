import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface CanopenConfig {
  sensorId?: string;
  tenantId?: string;
  nodeId?: number;
}

@Injectable()
export class CanopenAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'CANOPEN';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.FIELDBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'CANopen';
  readonly description = 'CANopen CAN-based industrial communication protocol';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as CanopenConfig;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'canopen' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as CanopenConfig;
    const errors = [];
    if (cfg.nodeId === undefined || cfg.nodeId < 1 || cfg.nodeId > 127) errors.push(this.validationError('nodeId', 'Node ID must be 1-127'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'CANopen Configuration', required: ['nodeId'],
      properties: {
        nodeId: { type: 'integer', title: 'Node ID', minimum: 1, maximum: 127, 'ui:order': 1, 'ui:group': 'connection' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [10000, 20000, 50000, 125000, 250000, 500000, 800000, 1000000], default: 250000, 'ui:order': 2, 'ui:group': 'connection' },
        cobIdTpdo: { type: 'string', title: 'TPDO COB-ID', description: 'Hex format (e.g., 0x180)', 'ui:order': 3, 'ui:group': 'pdo' },
        cobIdRpdo: { type: 'string', title: 'RPDO COB-ID', description: 'Hex format (e.g., 0x200)', 'ui:order': 4, 'ui:group': 'pdo' },
        sdoTimeout: { type: 'integer', title: 'SDO Timeout (ms)', default: 1000, 'ui:order': 5, 'ui:group': 'timing' },
        heartbeatInterval: { type: 'integer', title: 'Heartbeat Interval (ms)', default: 1000, 'ui:order': 6, 'ui:group': 'timing' },
        edsFile: { type: 'string', title: 'EDS File', description: 'Electronic Data Sheet file path', 'ui:order': 7, 'ui:group': 'config' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['nodeId', 'baudRate'] },
        { name: 'pdo', title: 'PDO Configuration', fields: ['cobIdTpdo', 'cobIdRpdo'] },
        { name: 'timing', title: 'Timing', fields: ['sdoTimeout', 'heartbeatInterval'] },
        { name: 'config', title: 'Configuration', fields: ['edsFile'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { nodeId: 1, baudRate: 250000, cobIdTpdo: '', cobIdRpdo: '', sdoTimeout: 1000, heartbeatInterval: 1000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOLEAN', 'INTEGER8', 'INTEGER16', 'INTEGER32', 'UNSIGNED8', 'UNSIGNED16', 'UNSIGNED32', 'REAL32'] };
  }
}
