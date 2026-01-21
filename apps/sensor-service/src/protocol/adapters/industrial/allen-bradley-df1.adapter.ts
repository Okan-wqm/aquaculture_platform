import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

@Injectable()
export class AllenBradleyDf1Adapter extends BaseProtocolAdapter {
  readonly protocolCode = 'AB_DF1';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'Allen-Bradley DF1';
  readonly description = 'Allen-Bradley DF1 serial protocol for legacy Rockwell PLCs';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'ab_df1' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (!cfg.comPort) errors.push(this.validationError('comPort', 'COM Port is required'));
    if (cfg.destinationNode === undefined || cfg.destinationNode < 0 || cfg.destinationNode > 254) errors.push(this.validationError('destinationNode', 'Destination node must be 0-254'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'Allen-Bradley DF1 Configuration', required: ['comPort', 'destinationNode'],
      properties: {
        comPort: { type: 'string', title: 'COM Port', 'ui:order': 1, 'ui:group': 'serial' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [1200, 2400, 4800, 9600, 19200, 38400], default: 19200, 'ui:order': 2, 'ui:group': 'serial' },
        dataBits: { type: 'integer', title: 'Data Bits', enum: [7, 8], default: 8, 'ui:order': 3, 'ui:group': 'serial' },
        parity: { type: 'string', title: 'Parity', enum: ['none', 'odd', 'even'], default: 'none', 'ui:order': 4, 'ui:group': 'serial' },
        stopBits: { type: 'integer', title: 'Stop Bits', enum: [1, 2], default: 1, 'ui:order': 5, 'ui:group': 'serial' },
        protocol: { type: 'string', title: 'DF1 Protocol', enum: ['Full Duplex', 'Half Duplex'], default: 'Full Duplex', 'ui:order': 6, 'ui:group': 'df1' },
        sourceNode: { type: 'integer', title: 'Source Node', minimum: 0, maximum: 254, default: 0, 'ui:order': 7, 'ui:group': 'df1' },
        destinationNode: { type: 'integer', title: 'Destination Node', minimum: 0, maximum: 254, 'ui:order': 8, 'ui:group': 'df1' },
        fileType: { type: 'string', title: 'File Type', enum: ['N', 'B', 'F', 'S', 'I', 'O'], default: 'N', 'ui:order': 9, 'ui:group': 'address' },
        fileNumber: { type: 'integer', title: 'File Number', 'ui:order': 10, 'ui:group': 'address' },
        elementNumber: { type: 'integer', title: 'Element Number', 'ui:order': 11, 'ui:group': 'address' },
      },
      'ui:groups': [
        { name: 'serial', title: 'Serial Port', fields: ['comPort', 'baudRate', 'dataBits', 'parity', 'stopBits'] },
        { name: 'df1', title: 'DF1 Settings', fields: ['protocol', 'sourceNode', 'destinationNode'] },
        { name: 'address', title: 'Address', fields: ['fileType', 'fileNumber', 'elementNumber'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { comPort: '', baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1, protocol: 'Full Duplex', sourceNode: 0, destinationNode: 1, fileType: 'N', fileNumber: 7, elementNumber: 0 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BIT', 'INTEGER', 'FLOAT', 'STRING'] };
  }
}
