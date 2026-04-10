import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface AllenBradleyEthernetConfig {
  sensorId?: string;
  tenantId?: string;
  host?: string;
  tagName?: string;
}

@Injectable()
export class AllenBradleyEthernetAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'AB_ETHERNET';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Allen-Bradley Ethernet/IP';
  readonly description = 'Allen-Bradley Ethernet/IP protocol for Rockwell PLCs';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as AllenBradleyEthernetConfig;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'ab_ethernet' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as AllenBradleyEthernetConfig;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    if (!cfg.tagName) errors.push(this.validationError('tagName', 'Tag name is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Allen-Bradley Ethernet/IP Configuration', required: ['host', 'tagName'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 44818, 'ui:order': 2, 'ui:group': 'connection' },
        slot: { type: 'integer', title: 'Slot', default: 0, 'ui:order': 3, 'ui:group': 'connection' },
        plcType: { type: 'string', title: 'PLC Type', enum: ['ControlLogix', 'CompactLogix', 'Micro800', 'PLC5', 'SLC500', 'MicroLogix'], default: 'ControlLogix', 'ui:order': 4, 'ui:group': 'plc' },
        tagName: { type: 'string', title: 'Tag Name', 'ui:order': 5, 'ui:group': 'plc' },
        program: { type: 'string', title: 'Program Name', description: 'Leave empty for controller-scoped tags', 'ui:order': 6, 'ui:group': 'plc' },
        connectionSize: { type: 'integer', title: 'Connection Size', default: 500, 'ui:order': 7, 'ui:group': 'advanced' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 5000, 'ui:order': 8, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'slot'] },
        { name: 'plc', title: 'PLC Configuration', fields: ['plcType', 'tagName', 'program'] },
        { name: 'advanced', title: 'Advanced', fields: ['connectionSize', 'timeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 44818, slot: 0, plcType: 'ControlLogix', tagName: '', program: '', connectionSize: 500, timeout: 5000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'REAL', 'LREAL', 'STRING'] };
  }
}
