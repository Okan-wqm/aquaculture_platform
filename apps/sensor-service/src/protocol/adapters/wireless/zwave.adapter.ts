import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class ZwaveAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ZWAVE';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.MESH;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'Z-Wave';
  readonly description = 'Z-Wave wireless mesh home automation protocol';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'zwave' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (cfg.nodeId === undefined || cfg.nodeId < 1 || cfg.nodeId > 232) errors.push(this.validationError('nodeId', 'Node ID must be 1-232'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Z-Wave Configuration', required: ['nodeId'],
      properties: {
        controllerPort: { type: 'string', title: 'Controller Port', description: 'Serial port of Z-Wave controller', 'ui:placeholder': '/dev/ttyACM0', 'ui:order': 1, 'ui:group': 'controller' },
        controllerType: { type: 'string', title: 'Controller Type', enum: ['Aeotec Z-Stick', 'Zooz ZST10', 'HUSBZB-1', 'RaZberry', 'Custom'], default: 'Aeotec Z-Stick', 'ui:order': 2, 'ui:group': 'controller' },
        homeId: { type: 'string', title: 'Home ID', description: '8 hex characters', 'ui:order': 3, 'ui:group': 'controller' },
        nodeId: { type: 'integer', title: 'Node ID', minimum: 1, maximum: 232, 'ui:order': 4, 'ui:group': 'device' },
        manufacturerId: { type: 'string', title: 'Manufacturer ID', 'ui:order': 5, 'ui:group': 'device' },
        productType: { type: 'string', title: 'Product Type', 'ui:order': 6, 'ui:group': 'device' },
        productId: { type: 'string', title: 'Product ID', 'ui:order': 7, 'ui:group': 'device' },
        commandClass: { type: 'string', title: 'Command Class', enum: ['SENSOR_MULTILEVEL', 'SENSOR_BINARY', 'METER', 'SWITCH_BINARY', 'SWITCH_MULTILEVEL', 'THERMOSTAT'], default: 'SENSOR_MULTILEVEL', 'ui:order': 8, 'ui:group': 'class' },
        endpoint: { type: 'integer', title: 'Endpoint', default: 0, minimum: 0, 'ui:order': 9, 'ui:group': 'class' },
        sensorType: { type: 'string', title: 'Sensor Type', enum: ['Temperature', 'Humidity', 'Luminance', 'Power', 'Energy', 'Voltage', 'Current'], 'ui:order': 10, 'ui:group': 'class' },
        pollInterval: { type: 'integer', title: 'Poll Interval (s)', default: 300, 'ui:order': 11, 'ui:group': 'advanced' },
        securityEnabled: { type: 'boolean', title: 'Security Enabled (S0/S2)', default: true, 'ui:order': 12, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'controller', title: 'Controller', fields: ['controllerPort', 'controllerType', 'homeId'] },
        { name: 'device', title: 'Device', fields: ['nodeId', 'manufacturerId', 'productType', 'productId'] },
        { name: 'class', title: 'Command Class', fields: ['commandClass', 'endpoint', 'sensorType'] },
        { name: 'advanced', title: 'Advanced', fields: ['pollInterval', 'securityEnabled'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { controllerPort: '', controllerType: 'Aeotec Z-Stick', homeId: '', nodeId: 1, commandClass: 'SENSOR_MULTILEVEL', endpoint: 0, pollInterval: 300, securityEnabled: true };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['BOOLEAN', 'BYTE', 'WORD', 'DWORD', 'FLOAT'] };
  }
}
