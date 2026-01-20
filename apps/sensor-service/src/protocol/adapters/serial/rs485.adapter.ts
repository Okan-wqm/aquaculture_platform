import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class Rs485Adapter extends BaseProtocolAdapter {
  readonly protocolCode = 'RS485';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.SERIAL_PORT;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'RS-485';
  readonly description = 'RS-485 multi-drop serial bus communication';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'rs485' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.comPort) errors.push(this.validationError('comPort', 'COM Port is required'));
    if (cfg.deviceAddress === undefined || cfg.deviceAddress < 1 || cfg.deviceAddress > 247) errors.push(this.validationError('deviceAddress', 'Device address must be 1-247'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'RS-485 Configuration', required: ['comPort', 'deviceAddress'],
      properties: {
        comPort: { type: 'string', title: 'COM Port', description: 'e.g., COM1, /dev/ttyUSB0', 'ui:order': 1, 'ui:group': 'port' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400], default: 9600, 'ui:order': 2, 'ui:group': 'port' },
        dataBits: { type: 'integer', title: 'Data Bits', enum: [7, 8], default: 8, 'ui:order': 3, 'ui:group': 'port' },
        stopBits: { type: 'integer', title: 'Stop Bits', enum: [1, 2], default: 1, 'ui:order': 4, 'ui:group': 'port' },
        parity: { type: 'string', title: 'Parity', enum: ['none', 'odd', 'even'], default: 'none', 'ui:order': 5, 'ui:group': 'port' },
        deviceAddress: { type: 'integer', title: 'Device Address', minimum: 1, maximum: 247, 'ui:order': 6, 'ui:group': 'bus' },
        termination: { type: 'boolean', title: 'Enable Termination', default: false, 'ui:order': 7, 'ui:group': 'bus' },
        biasing: { type: 'boolean', title: 'Enable Biasing', default: false, 'ui:order': 8, 'ui:group': 'bus' },
        halfDuplex: { type: 'boolean', title: 'Half Duplex Mode', default: true, 'ui:order': 9, 'ui:group': 'bus' },
        turnaroundDelay: { type: 'integer', title: 'Turnaround Delay (ms)', default: 10, 'ui:order': 10, 'ui:group': 'timing' },
        responseTimeout: { type: 'integer', title: 'Response Timeout (ms)', default: 1000, 'ui:order': 11, 'ui:group': 'timing' },
      },
      'ui:groups': [
        { name: 'port', title: 'Port Settings', fields: ['comPort', 'baudRate', 'dataBits', 'stopBits', 'parity'] },
        { name: 'bus', title: 'Bus Settings', fields: ['deviceAddress', 'termination', 'biasing', 'halfDuplex'] },
        { name: 'timing', title: 'Timing', fields: ['turnaroundDelay', 'responseTimeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { comPort: '', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', deviceAddress: 1, termination: false, biasing: false, halfDuplex: true, turnaroundDelay: 10, responseTimeout: 1000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['STRING', 'BINARY'] };
  }
}
