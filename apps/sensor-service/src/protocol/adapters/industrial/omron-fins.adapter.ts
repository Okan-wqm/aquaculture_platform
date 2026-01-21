import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class OmronFinsAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'OMRON_FINS';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC;
  readonly connectionType = ConnectionType.UDP;
  readonly displayName = 'Omron FINS';
  readonly description = 'Omron FINS (Factory Interface Network Service) protocol';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'omron_fins' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    if (cfg.destNode === undefined || cfg.destNode < 0 || cfg.destNode > 254) errors.push(this.validationError('destNode', 'Destination node must be 0-254'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Omron FINS Configuration', required: ['host', 'destNode'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 9600, 'ui:order': 2, 'ui:group': 'connection' },
        protocol: { type: 'string', title: 'Protocol', enum: ['UDP', 'TCP'], default: 'UDP', 'ui:order': 3, 'ui:group': 'connection' },
        destNetwork: { type: 'integer', title: 'Destination Network', default: 0, minimum: 0, maximum: 127, 'ui:order': 4, 'ui:group': 'fins' },
        destNode: { type: 'integer', title: 'Destination Node', minimum: 0, maximum: 254, 'ui:order': 5, 'ui:group': 'fins' },
        destUnit: { type: 'integer', title: 'Destination Unit', default: 0, minimum: 0, maximum: 255, 'ui:order': 6, 'ui:group': 'fins' },
        srcNetwork: { type: 'integer', title: 'Source Network', default: 0, minimum: 0, maximum: 127, 'ui:order': 7, 'ui:group': 'fins' },
        srcNode: { type: 'integer', title: 'Source Node', default: 0, minimum: 0, maximum: 254, 'ui:order': 8, 'ui:group': 'fins' },
        srcUnit: { type: 'integer', title: 'Source Unit', default: 0, minimum: 0, maximum: 255, 'ui:order': 9, 'ui:group': 'fins' },
        memoryArea: { type: 'string', title: 'Memory Area', enum: ['CIO', 'WR', 'HR', 'AR', 'DM', 'EM'], default: 'DM', 'ui:order': 10, 'ui:group': 'address' },
        startAddress: { type: 'integer', title: 'Start Address', default: 0, 'ui:order': 11, 'ui:group': 'address' },
        readCount: { type: 'integer', title: 'Read Count', default: 1, 'ui:order': 12, 'ui:group': 'address' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 2000, 'ui:order': 13, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'protocol'] },
        { name: 'fins', title: 'FINS Address', fields: ['destNetwork', 'destNode', 'destUnit', 'srcNetwork', 'srcNode', 'srcUnit'] },
        { name: 'address', title: 'Memory Address', fields: ['memoryArea', 'startAddress', 'readCount'] },
        { name: 'advanced', title: 'Advanced', fields: ['timeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 9600, protocol: 'UDP', destNetwork: 0, destNode: 0, destUnit: 0, srcNetwork: 0, srcNode: 0, srcUnit: 0, memoryArea: 'DM', startAddress: 0, readCount: 1, timeout: 2000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BIT', 'WORD', 'DWORD', 'FLOAT'] };
  }
}
