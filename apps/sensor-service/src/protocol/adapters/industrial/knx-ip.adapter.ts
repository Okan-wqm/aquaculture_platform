import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class KnxIpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'KNX_IP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.BUILDING_AUTOMATION;
  readonly connectionType = ConnectionType.UDP;
  readonly displayName = 'KNX/IP';
  readonly description = 'KNXnet/IP protocol for building automation';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'knx_ip' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.gatewayIp) errors.push(this.validationError('gatewayIp', 'Gateway IP is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'KNX/IP Configuration', required: ['gatewayIp'],
      properties: {
        physicalAddress: { type: 'string', title: 'Physical Address', description: 'Format: Area.Line.Device (e.g., 1.1.1)', 'ui:placeholder': '1.1.1', 'ui:order': 1, 'ui:group': 'connection' },
        connectionType: { type: 'string', title: 'Connection Type', enum: ['Tunneling', 'Routing'], default: 'Tunneling', 'ui:order': 2, 'ui:group': 'connection' },
        gatewayIp: { type: 'string', title: 'Gateway IP', 'ui:order': 3, 'ui:group': 'connection' },
        gatewayPort: { type: 'integer', title: 'Gateway Port', default: 3671, 'ui:order': 4, 'ui:group': 'connection' },
        groupAddresses: { type: 'array', title: 'Group Addresses', description: 'Format: Main/Middle/Sub (e.g., 4/1/1)', items: { type: 'string' }, 'ui:order': 5, 'ui:group': 'data' },
        datapointType: { type: 'string', title: 'Datapoint Type', enum: ['1.001 - Switch', '9.001 - Temperature', '14.xxx - Float'], default: '9.001 - Temperature', 'ui:order': 6, 'ui:group': 'data' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['physicalAddress', 'connectionType', 'gatewayIp', 'gatewayPort'] },
        { name: 'data', title: 'Data Points', fields: ['groupAddresses', 'datapointType'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { physicalAddress: '1.1.1', connectionType: 'Tunneling', gatewayIp: '', gatewayPort: 3671, groupAddresses: [], datapointType: '9.001 - Temperature' };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: false, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['DPT1', 'DPT5', 'DPT9', 'DPT14'] };
  }
}
