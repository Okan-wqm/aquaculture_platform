import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class LorawanAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'LORAWAN';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.LPWAN;
  readonly connectionType = ConnectionType.WIRELESS;
  readonly displayName = 'LoRaWAN';
  readonly description = 'LoRaWAN Low Power Wide Area Network protocol';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'lorawan' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.devEui) errors.push(this.validationError('devEui', 'Device EUI is required'));
    if (cfg.activationMode === 'OTAA') {
      if (!cfg.appKey) errors.push(this.validationError('appKey', 'App Key is required for OTAA'));
      if (!cfg.appEui) errors.push(this.validationError('appEui', 'App EUI is required for OTAA'));
    } else if (cfg.activationMode === 'ABP') {
      if (!cfg.devAddr) errors.push(this.validationError('devAddr', 'Device Address is required for ABP'));
      if (!cfg.nwkSKey) errors.push(this.validationError('nwkSKey', 'Network Session Key is required for ABP'));
      if (!cfg.appSKey) errors.push(this.validationError('appSKey', 'App Session Key is required for ABP'));
    }
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'LoRaWAN Configuration', required: ['devEui', 'activationMode'],
      properties: {
        networkServer: { type: 'string', title: 'Network Server URL', 'ui:order': 1, 'ui:group': 'network' },
        networkServerType: { type: 'string', title: 'Network Server Type', enum: ['The Things Network', 'ChirpStack', 'Loriot', 'AWS IoT Core', 'Custom'], default: 'The Things Network', 'ui:order': 2, 'ui:group': 'network' },
        region: { type: 'string', title: 'Region', enum: ['EU868', 'US915', 'AU915', 'AS923', 'KR920', 'IN865', 'RU864'], default: 'EU868', 'ui:order': 3, 'ui:group': 'network' },
        devEui: { type: 'string', title: 'Device EUI', description: '16 hex characters', 'ui:placeholder': '0011223344556677', 'ui:order': 4, 'ui:group': 'device' },
        activationMode: { type: 'string', title: 'Activation Mode', enum: ['OTAA', 'ABP'], default: 'OTAA', 'ui:order': 5, 'ui:group': 'device' },
        deviceClass: { type: 'string', title: 'Device Class', enum: ['A', 'B', 'C'], default: 'A', 'ui:order': 6, 'ui:group': 'device' },
        appEui: { type: 'string', title: 'App EUI (OTAA)', description: '16 hex characters', 'ui:order': 7, 'ui:group': 'otaa' },
        appKey: { type: 'string', title: 'App Key (OTAA)', description: '32 hex characters', 'ui:order': 8, 'ui:group': 'otaa', 'ui:widget': 'password' },
        devAddr: { type: 'string', title: 'Device Address (ABP)', description: '8 hex characters', 'ui:order': 9, 'ui:group': 'abp' },
        nwkSKey: { type: 'string', title: 'Network Session Key (ABP)', description: '32 hex characters', 'ui:order': 10, 'ui:group': 'abp', 'ui:widget': 'password' },
        appSKey: { type: 'string', title: 'App Session Key (ABP)', description: '32 hex characters', 'ui:order': 11, 'ui:group': 'abp', 'ui:widget': 'password' },
        fPort: { type: 'integer', title: 'FPort', default: 1, minimum: 1, maximum: 223, 'ui:order': 12, 'ui:group': 'advanced' },
        adr: { type: 'boolean', title: 'ADR (Adaptive Data Rate)', default: true, 'ui:order': 13, 'ui:group': 'advanced' },
        confirmed: { type: 'boolean', title: 'Confirmed Uplinks', default: false, 'ui:order': 14, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'network', title: 'Network Server', fields: ['networkServer', 'networkServerType', 'region'] },
        { name: 'device', title: 'Device', fields: ['devEui', 'activationMode', 'deviceClass'] },
        { name: 'otaa', title: 'OTAA Keys', fields: ['appEui', 'appKey'] },
        { name: 'abp', title: 'ABP Keys', fields: ['devAddr', 'nwkSKey', 'appSKey'] },
        { name: 'advanced', title: 'Advanced', fields: ['fPort', 'adr', 'confirmed'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { networkServer: '', networkServerType: 'The Things Network', region: 'EU868', devEui: '', activationMode: 'OTAA', deviceClass: 'A', appEui: '', appKey: '', fPort: 1, adr: true, confirmed: false };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: false, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['BINARY', 'CAYENNE_LPP', 'JSON'] };
  }
}
