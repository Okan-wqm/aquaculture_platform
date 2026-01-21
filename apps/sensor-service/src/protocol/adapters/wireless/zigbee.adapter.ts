import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class ZigbeeAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ZIGBEE';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.MESH;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'Zigbee';
  readonly description = 'Zigbee wireless mesh network protocol';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'zigbee' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.ieeeAddress) errors.push(this.validationError('ieeeAddress', 'IEEE Address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Zigbee Configuration', required: ['ieeeAddress'],
      properties: {
        coordinatorPort: { type: 'string', title: 'Coordinator Port', description: 'Serial port of Zigbee coordinator', 'ui:placeholder': '/dev/ttyUSB0', 'ui:order': 1, 'ui:group': 'coordinator' },
        coordinatorType: { type: 'string', title: 'Coordinator Type', enum: ['CC2531', 'CC2652', 'ConBee II', 'Sonoff ZBBridge', 'Custom'], default: 'CC2652', 'ui:order': 2, 'ui:group': 'coordinator' },
        panId: { type: 'string', title: 'PAN ID', description: '4 hex characters', 'ui:placeholder': '1A62', 'ui:order': 3, 'ui:group': 'coordinator' },
        channel: { type: 'integer', title: 'Channel', enum: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26], default: 11, 'ui:order': 4, 'ui:group': 'coordinator' },
        ieeeAddress: { type: 'string', title: 'IEEE Address', description: '16 hex characters', 'ui:placeholder': '0x00124b001cd4d21e', 'ui:order': 5, 'ui:group': 'device' },
        networkAddress: { type: 'string', title: 'Network Address', description: 'Auto-assigned or manual', 'ui:order': 6, 'ui:group': 'device' },
        deviceType: { type: 'string', title: 'Device Type', enum: ['EndDevice', 'Router', 'Coordinator'], default: 'EndDevice', 'ui:order': 7, 'ui:group': 'device' },
        endpoint: { type: 'integer', title: 'Endpoint', default: 1, minimum: 1, maximum: 240, 'ui:order': 8, 'ui:group': 'cluster' },
        clusterId: { type: 'string', title: 'Cluster ID', description: 'e.g., 0x0402 for Temperature', 'ui:placeholder': '0x0402', 'ui:order': 9, 'ui:group': 'cluster' },
        attributeId: { type: 'string', title: 'Attribute ID', 'ui:placeholder': '0x0000', 'ui:order': 10, 'ui:group': 'cluster' },
        reportingInterval: { type: 'integer', title: 'Reporting Interval (s)', default: 60, 'ui:order': 11, 'ui:group': 'reporting' },
        minReportingInterval: { type: 'integer', title: 'Min Reporting Interval (s)', default: 10, 'ui:order': 12, 'ui:group': 'reporting' },
      },
      'ui:groups': [
        { name: 'coordinator', title: 'Coordinator', fields: ['coordinatorPort', 'coordinatorType', 'panId', 'channel'] },
        { name: 'device', title: 'Device', fields: ['ieeeAddress', 'networkAddress', 'deviceType'] },
        { name: 'cluster', title: 'Cluster', fields: ['endpoint', 'clusterId', 'attributeId'] },
        { name: 'reporting', title: 'Reporting', fields: ['reportingInterval', 'minReportingInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { coordinatorPort: '', coordinatorType: 'CC2652', panId: '', channel: 11, ieeeAddress: '', deviceType: 'EndDevice', endpoint: 1, clusterId: '', attributeId: '', reportingInterval: 60, minReportingInterval: 10 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['BOOLEAN', 'UINT8', 'UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT', 'STRING'] };
  }
}
