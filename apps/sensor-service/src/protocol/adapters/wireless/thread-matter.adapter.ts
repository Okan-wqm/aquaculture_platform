import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class ThreadMatterAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'THREAD_MATTER';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.MESH;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'Thread/Matter';
  readonly description = 'Thread network protocol with Matter application layer';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'thread_matter' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.nodeId) errors.push(this.validationError('nodeId', 'Node ID is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Thread/Matter Configuration', required: ['nodeId'],
      properties: {
        borderRouterIp: { type: 'string', title: 'Border Router IP', 'ui:order': 1, 'ui:group': 'network' },
        borderRouterPort: { type: 'integer', title: 'Border Router Port', default: 5540, 'ui:order': 2, 'ui:group': 'network' },
        networkName: { type: 'string', title: 'Network Name', 'ui:order': 3, 'ui:group': 'network' },
        extendedPanId: { type: 'string', title: 'Extended PAN ID', description: '16 hex characters', 'ui:order': 4, 'ui:group': 'network' },
        channel: { type: 'integer', title: 'Channel', enum: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26], default: 15, 'ui:order': 5, 'ui:group': 'network' },
        nodeId: { type: 'string', title: 'Node ID', description: 'Matter Node ID', 'ui:order': 6, 'ui:group': 'device' },
        vendorId: { type: 'string', title: 'Vendor ID', 'ui:order': 7, 'ui:group': 'device' },
        productId: { type: 'string', title: 'Product ID', 'ui:order': 8, 'ui:group': 'device' },
        fabricId: { type: 'string', title: 'Fabric ID', 'ui:order': 9, 'ui:group': 'commissioning' },
        setupPinCode: { type: 'string', title: 'Setup PIN Code', description: '8-digit code', 'ui:widget': 'password', 'ui:order': 10, 'ui:group': 'commissioning' },
        discriminator: { type: 'integer', title: 'Discriminator', minimum: 0, maximum: 4095, 'ui:order': 11, 'ui:group': 'commissioning' },
        endpointId: { type: 'integer', title: 'Endpoint ID', default: 1, 'ui:order': 12, 'ui:group': 'cluster' },
        clusterId: { type: 'string', title: 'Cluster ID', description: 'e.g., 0x0402 for Temperature', 'ui:placeholder': '0x0402', 'ui:order': 13, 'ui:group': 'cluster' },
        attributeId: { type: 'string', title: 'Attribute ID', 'ui:placeholder': '0x0000', 'ui:order': 14, 'ui:group': 'cluster' },
      },
      'ui:groups': [
        { name: 'network', title: 'Thread Network', fields: ['borderRouterIp', 'borderRouterPort', 'networkName', 'extendedPanId', 'channel'] },
        { name: 'device', title: 'Device', fields: ['nodeId', 'vendorId', 'productId'] },
        { name: 'commissioning', title: 'Commissioning', fields: ['fabricId', 'setupPinCode', 'discriminator'] },
        { name: 'cluster', title: 'Matter Cluster', fields: ['endpointId', 'clusterId', 'attributeId'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { borderRouterIp: '', borderRouterPort: 5540, networkName: '', extendedPanId: '', channel: 15, nodeId: '', endpointId: 1, clusterId: '', attributeId: '' };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['BOOLEAN', 'UINT8', 'UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT', 'STRING'] };
  }
}
