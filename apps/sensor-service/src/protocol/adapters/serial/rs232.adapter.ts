import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

interface Rs232Config {
  sensorId?: string;
  tenantId?: string;
  comPort?: string;
}

@Injectable()
export class Rs232Adapter extends BaseProtocolAdapter {
  readonly protocolCode = 'RS232';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.SERIAL_PORT;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'RS-232';
  readonly description = 'RS-232 serial port communication';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as Rs232Config;
    return this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async readData(_handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'rs232' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as Rs232Config;
    const errors = [];
    if (!cfg.comPort) errors.push(this.validationError('comPort', 'COM Port is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'RS-232 Configuration', required: ['comPort'],
      properties: {
        comPort: { type: 'string', title: 'COM Port', description: 'e.g., COM1, /dev/ttyUSB0', 'ui:order': 1, 'ui:group': 'port' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600], default: 9600, 'ui:order': 2, 'ui:group': 'port' },
        dataBits: { type: 'integer', title: 'Data Bits', enum: [5, 6, 7, 8], default: 8, 'ui:order': 3, 'ui:group': 'port' },
        stopBits: { type: 'number', title: 'Stop Bits', enum: [1, 1.5, 2], default: 1, 'ui:order': 4, 'ui:group': 'port' },
        parity: { type: 'string', title: 'Parity', enum: ['none', 'odd', 'even', 'mark', 'space'], default: 'none', 'ui:order': 5, 'ui:group': 'port' },
        flowControl: { type: 'string', title: 'Flow Control', enum: ['none', 'xon/xoff', 'rts/cts', 'dtr/dsr'], default: 'none', 'ui:order': 6, 'ui:group': 'flow' },
        rtscts: { type: 'boolean', title: 'RTS/CTS', default: false, 'ui:order': 7, 'ui:group': 'flow' },
        xon: { type: 'boolean', title: 'XON/XOFF', default: false, 'ui:order': 8, 'ui:group': 'flow' },
        delimiter: { type: 'string', title: 'Delimiter', default: '\n', 'ui:order': 9, 'ui:group': 'parsing' },
        encoding: { type: 'string', title: 'Encoding', enum: ['utf8', 'ascii', 'hex', 'binary'], default: 'utf8', 'ui:order': 10, 'ui:group': 'parsing' },
      },
      'ui:groups': [
        { name: 'port', title: 'Port Settings', fields: ['comPort', 'baudRate', 'dataBits', 'stopBits', 'parity'] },
        { name: 'flow', title: 'Flow Control', fields: ['flowControl', 'rtscts', 'xon'] },
        { name: 'parsing', title: 'Data Parsing', fields: ['delimiter', 'encoding'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { comPort: '', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', rtscts: false, xon: false, delimiter: '\n', encoding: 'utf8' };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: true, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['STRING', 'BINARY'] };
  }
}
