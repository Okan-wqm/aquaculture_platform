import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class SpiAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'SPI';
  readonly category = ProtocolCategory.SERIAL;
  readonly subcategory = ProtocolSubcategory.BUS;
  readonly connectionType = ConnectionType.SPI;
  readonly displayName = 'SPI';
  readonly description = 'SPI (Serial Peripheral Interface) bus communication';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'spi' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (cfg.busNumber === undefined || cfg.busNumber < 0) errors.push(this.validationError('busNumber', 'Bus number is required'));
    if (cfg.chipSelect === undefined || cfg.chipSelect < 0) errors.push(this.validationError('chipSelect', 'Chip select is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'SPI Configuration', required: ['busNumber', 'chipSelect'],
      properties: {
        busNumber: { type: 'integer', title: 'Bus Number', description: 'e.g., 0 for /dev/spidev0.x', minimum: 0, 'ui:order': 1, 'ui:group': 'bus' },
        chipSelect: { type: 'integer', title: 'Chip Select (CS)', minimum: 0, 'ui:order': 2, 'ui:group': 'bus' },
        clockSpeed: { type: 'integer', title: 'Clock Speed (Hz)', default: 1000000, 'ui:order': 3, 'ui:group': 'bus' },
        mode: { type: 'integer', title: 'SPI Mode', enum: [0, 1, 2, 3], default: 0, description: 'Mode 0: CPOL=0, CPHA=0', 'ui:order': 4, 'ui:group': 'config' },
        bitsPerWord: { type: 'integer', title: 'Bits Per Word', enum: [8, 16, 32], default: 8, 'ui:order': 5, 'ui:group': 'config' },
        lsbFirst: { type: 'boolean', title: 'LSB First', default: false, 'ui:order': 6, 'ui:group': 'config' },
        csActiveHigh: { type: 'boolean', title: 'CS Active High', default: false, 'ui:order': 7, 'ui:group': 'config' },
        fullDuplex: { type: 'boolean', title: 'Full Duplex', default: true, 'ui:order': 8, 'ui:group': 'config' },
        readCommand: { type: 'string', title: 'Read Command', description: 'Hex bytes to send before read (e.g., 0x80)', 'ui:order': 9, 'ui:group': 'read' },
        readLength: { type: 'integer', title: 'Read Length (bytes)', default: 1, 'ui:order': 10, 'ui:group': 'read' },
      },
      'ui:groups': [
        { name: 'bus', title: 'Bus Settings', fields: ['busNumber', 'chipSelect', 'clockSpeed'] },
        { name: 'config', title: 'Configuration', fields: ['mode', 'bitsPerWord', 'lsbFirst', 'csActiveHigh', 'fullDuplex'] },
        { name: 'read', title: 'Read Configuration', fields: ['readCommand', 'readLength'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { busNumber: 0, chipSelect: 0, clockSpeed: 1000000, mode: 0, bitsPerWord: 8, lsbFirst: false, csActiveHigh: false, fullDuplex: true, readCommand: '', readLength: 1 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BYTE', 'WORD', 'DWORD'] };
  }
}
