import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class MitsubishiMcAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'MITSUBISHI_MC';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Mitsubishi MC Protocol';
  readonly description = 'Mitsubishi MC Protocol (MELSEC Communication) for Mitsubishi PLCs';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'mitsubishi_mc' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Mitsubishi MC Protocol Configuration', required: ['host'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 5000, 'ui:order': 2, 'ui:group': 'connection' },
        plcType: { type: 'string', title: 'PLC Type', enum: ['Q/QnA', 'iQ-R', 'iQ-F', 'L', 'A'], default: 'iQ-R', 'ui:order': 3, 'ui:group': 'plc' },
        protocolFormat: { type: 'string', title: 'Protocol Format', enum: ['Binary', 'ASCII'], default: 'Binary', 'ui:order': 4, 'ui:group': 'plc' },
        frameType: { type: 'string', title: 'Frame Type', enum: ['3E', '4E', '1E'], default: '3E', 'ui:order': 5, 'ui:group': 'plc' },
        networkNumber: { type: 'integer', title: 'Network Number', default: 0, 'ui:order': 6, 'ui:group': 'network' },
        pcNumber: { type: 'integer', title: 'PC Number', default: 255, 'ui:order': 7, 'ui:group': 'network' },
        unitIoNumber: { type: 'string', title: 'Unit I/O Number', default: '03FF', 'ui:order': 8, 'ui:group': 'network' },
        unitStationNumber: { type: 'integer', title: 'Unit Station Number', default: 0, 'ui:order': 9, 'ui:group': 'network' },
        deviceType: { type: 'string', title: 'Device Type', enum: ['D', 'W', 'R', 'X', 'Y', 'M', 'B', 'L'], default: 'D', 'ui:order': 10, 'ui:group': 'address' },
        startAddress: { type: 'integer', title: 'Start Address', default: 0, 'ui:order': 11, 'ui:group': 'address' },
        readCount: { type: 'integer', title: 'Read Count', default: 1, 'ui:order': 12, 'ui:group': 'address' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 5000, 'ui:order': 13, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port'] },
        { name: 'plc', title: 'PLC Settings', fields: ['plcType', 'protocolFormat', 'frameType'] },
        { name: 'network', title: 'Network', fields: ['networkNumber', 'pcNumber', 'unitIoNumber', 'unitStationNumber'] },
        { name: 'address', title: 'Device Address', fields: ['deviceType', 'startAddress', 'readCount'] },
        { name: 'advanced', title: 'Advanced', fields: ['timeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 5000, plcType: 'iQ-R', protocolFormat: 'Binary', frameType: '3E', networkNumber: 0, pcNumber: 255, unitIoNumber: '03FF', unitStationNumber: 0, deviceType: 'D', startAddress: 0, readCount: 1, timeout: 5000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BIT', 'WORD', 'DWORD', 'FLOAT'] };
  }
}
