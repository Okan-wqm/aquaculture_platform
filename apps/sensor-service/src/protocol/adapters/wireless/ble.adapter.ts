import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class BleAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'BLE';
  readonly category = ProtocolCategory.WIRELESS;
  readonly subcategory = ProtocolSubcategory.SHORT_RANGE;
  readonly connectionType = ConnectionType.BLUETOOTH;
  readonly displayName = 'Bluetooth Low Energy';
  readonly description = 'Bluetooth Low Energy (BLE) wireless protocol';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'ble' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.macAddress) errors.push(this.validationError('macAddress', 'MAC Address is required'));
    if (!cfg.serviceUuid) errors.push(this.validationError('serviceUuid', 'Service UUID is required'));
    if (!cfg.characteristicUuid) errors.push(this.validationError('characteristicUuid', 'Characteristic UUID is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'BLE Configuration', required: ['macAddress', 'serviceUuid', 'characteristicUuid'],
      properties: {
        adapterIndex: { type: 'integer', title: 'Adapter Index', default: 0, description: 'e.g., 0 for hci0', 'ui:order': 1, 'ui:group': 'adapter' },
        macAddress: { type: 'string', title: 'MAC Address', description: 'Format: AA:BB:CC:DD:EE:FF', 'ui:placeholder': 'AA:BB:CC:DD:EE:FF', 'ui:order': 2, 'ui:group': 'device' },
        addressType: { type: 'string', title: 'Address Type', enum: ['public', 'random'], default: 'public', 'ui:order': 3, 'ui:group': 'device' },
        deviceName: { type: 'string', title: 'Device Name', description: 'Optional friendly name', 'ui:order': 4, 'ui:group': 'device' },
        serviceUuid: { type: 'string', title: 'Service UUID', description: '16-bit or 128-bit UUID', 'ui:placeholder': '0000180f-0000-1000-8000-00805f9b34fb', 'ui:order': 5, 'ui:group': 'gatt' },
        characteristicUuid: { type: 'string', title: 'Characteristic UUID', 'ui:placeholder': '00002a19-0000-1000-8000-00805f9b34fb', 'ui:order': 6, 'ui:group': 'gatt' },
        descriptorUuid: { type: 'string', title: 'Descriptor UUID', 'ui:order': 7, 'ui:group': 'gatt' },
        readMode: { type: 'string', title: 'Read Mode', enum: ['read', 'notify', 'indicate'], default: 'notify', 'ui:order': 8, 'ui:group': 'options' },
        connectionInterval: { type: 'integer', title: 'Connection Interval (ms)', default: 50, 'ui:order': 9, 'ui:group': 'options' },
        mtu: { type: 'integer', title: 'MTU Size', default: 23, minimum: 23, maximum: 517, 'ui:order': 10, 'ui:group': 'options' },
        autoReconnect: { type: 'boolean', title: 'Auto Reconnect', default: true, 'ui:order': 11, 'ui:group': 'options' },
        passkey: { type: 'string', title: 'Passkey', description: '6-digit PIN for pairing', 'ui:widget': 'password', 'ui:order': 12, 'ui:group': 'security' },
      },
      'ui:groups': [
        { name: 'adapter', title: 'Adapter', fields: ['adapterIndex'] },
        { name: 'device', title: 'Device', fields: ['macAddress', 'addressType', 'deviceName'] },
        { name: 'gatt', title: 'GATT', fields: ['serviceUuid', 'characteristicUuid', 'descriptorUuid'] },
        { name: 'options', title: 'Options', fields: ['readMode', 'connectionInterval', 'mtu', 'autoReconnect'] },
        { name: 'security', title: 'Security', fields: ['passkey'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { adapterIndex: 0, macAddress: '', addressType: 'public', serviceUuid: '', characteristicUuid: '', readMode: 'notify', connectionInterval: 50, mtu: 23, autoReconnect: true };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: true, supportsEncryption: true, supportedDataTypes: ['UINT8', 'UINT16', 'INT16', 'FLOAT', 'STRING', 'BINARY'] };
  }
}
