import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface OneWireConfig {
  sensorId?: string;
  tenantId?: string;
  deviceId?: string;
}

@Injectable()
export class OneWireAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ONE_WIRE';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.BUS;
  readonly connectionType = ConnectionType.ONE_WIRE;
  readonly displayName = '1-Wire';
  readonly description = 'Dallas/Maxim 1-Wire serial bus protocol';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as OneWireConfig;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'one_wire' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as OneWireConfig;
    const errors = [];
    if (!cfg.deviceId) errors.push(this.validationError('deviceId', 'Device ID is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: '1-Wire Configuration', required: ['deviceId'],
      properties: {
        busPath: { type: 'string', title: 'Bus Path', description: 'e.g., /sys/bus/w1/devices', default: '/sys/bus/w1/devices', 'ui:order': 1, 'ui:group': 'bus' },
        masterDevice: { type: 'string', title: 'Master Device', description: 'e.g., w1_bus_master1', default: 'w1_bus_master1', 'ui:order': 2, 'ui:group': 'bus' },
        deviceId: { type: 'string', title: 'Device ID', description: '64-bit ROM code (e.g., 28-0123456789ab)', 'ui:placeholder': '28-0123456789ab', 'ui:order': 3, 'ui:group': 'device' },
        deviceFamily: { type: 'string', title: 'Device Family', enum: ['DS18B20 (28)', 'DS18S20 (10)', 'DS1822 (22)', 'DS2438 (26)', 'DS2413 (3A)', 'DS2408 (29)'], default: 'DS18B20 (28)', 'ui:order': 4, 'ui:group': 'device' },
        resolution: { type: 'integer', title: 'Resolution (bits)', enum: [9, 10, 11, 12], default: 12, description: 'For temperature sensors', 'ui:order': 5, 'ui:group': 'config' },
        parasitePower: { type: 'boolean', title: 'Parasite Power Mode', default: false, 'ui:order': 6, 'ui:group': 'config' },
        conversionTime: { type: 'integer', title: 'Conversion Time (ms)', default: 750, description: 'Time to wait for conversion', 'ui:order': 7, 'ui:group': 'config' },
      },
      'ui:groups': [
        { name: 'bus', title: 'Bus Settings', fields: ['busPath', 'masterDevice'] },
        { name: 'device', title: 'Device', fields: ['deviceId', 'deviceFamily'] },
        { name: 'config', title: 'Configuration', fields: ['resolution', 'parasitePower', 'conversionTime'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { busPath: '/sys/bus/w1/devices', masterDevice: 'w1_bus_master1', deviceId: '', deviceFamily: 'DS18B20 (28)', resolution: 12, parasitePower: false, conversionTime: 750 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['TEMPERATURE', 'HUMIDITY', 'DIGITAL', 'ANALOG'] };
  }
}
