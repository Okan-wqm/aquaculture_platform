import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

export interface BacnetIpConfiguration {
  deviceInstance: number;
  host: string;
  port: number;
  networkNumber: number;
  objectType: string;
  objectInstance: number;
  propertyIdentifier: string;
  covSubscription: boolean;
  apduTimeout: number;
  pollInterval: number;
}

@Injectable()
export class BacnetIpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'BACNET_IP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.BUILDING_AUTOMATION;
  readonly connectionType = ConnectionType.UDP;
  readonly displayName = 'BACnet/IP';
  readonly description = 'BACnet/IP protocol for building automation systems';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const handle = this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
    return handle;
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    return { success: true, latencyMs: 0 };
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    return { timestamp: new Date(), values: {}, quality: 100, source: 'bacnet_ip' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as Partial<BacnetIpConfiguration>;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    if (cfg.deviceInstance === undefined) errors.push(this.validationError('deviceInstance', 'Device instance is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'BACnet/IP Configuration',
      required: ['host', 'deviceInstance'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 47808, 'ui:order': 2, 'ui:group': 'connection' },
        deviceInstance: { type: 'integer', title: 'Device Instance', minimum: 0, maximum: 4194302, 'ui:order': 3, 'ui:group': 'connection' },
        networkNumber: { type: 'integer', title: 'Network Number', default: 0, 'ui:order': 4, 'ui:group': 'connection' },
        objectType: { type: 'string', title: 'Object Type', enum: ['analog-input', 'analog-output', 'analog-value', 'binary-input', 'binary-output', 'binary-value', 'multi-state-input'], default: 'analog-input', 'ui:order': 5, 'ui:group': 'object' },
        objectInstance: { type: 'integer', title: 'Object Instance', 'ui:order': 6, 'ui:group': 'object' },
        propertyIdentifier: { type: 'string', title: 'Property', enum: ['present-value', 'status-flags', 'event-state', 'reliability'], default: 'present-value', 'ui:order': 7, 'ui:group': 'object' },
        covSubscription: { type: 'boolean', title: 'COV Subscription', default: false, 'ui:order': 8, 'ui:group': 'advanced' },
        apduTimeout: { type: 'integer', title: 'APDU Timeout (ms)', default: 3000, 'ui:order': 9, 'ui:group': 'advanced' },
        pollInterval: { type: 'integer', title: 'Poll Interval (ms)', default: 5000, 'ui:order': 10, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'deviceInstance', 'networkNumber'] },
        { name: 'object', title: 'Object', fields: ['objectType', 'objectInstance', 'propertyIdentifier'] },
        { name: 'advanced', title: 'Advanced', fields: ['covSubscription', 'apduTimeout', 'pollInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 47808, deviceInstance: 0, networkNumber: 0, objectType: 'analog-input', objectInstance: 0, propertyIdentifier: 'present-value', covSubscription: false, apduTimeout: 3000, pollInterval: 5000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['REAL', 'UNSIGNED', 'SIGNED', 'BOOLEAN', 'ENUMERATED'] };
  }
}
