import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';
import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';

@Injectable()
export class CclinkAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'CCLINK';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.FIELDBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'CC-Link';
  readonly description = 'CC-Link fieldbus protocol for Mitsubishi automation systems';

  constructor(configService: ConfigService) { super(configService); }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    return this.createConnectionHandle(config.sensorId as string || 'unknown', config.tenantId as string || 'unknown', config);
  }
  async disconnect(handle: ConnectionHandle): Promise<void> { this.removeConnectionHandle(handle.id); }
  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> { return { success: true, latencyMs: 0 }; }
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> { return { timestamp: new Date(), values: {}, quality: 100, source: 'cclink' }; }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as any;
    const errors = [];
    if (cfg.stationNumber === undefined || cfg.stationNumber < 1 || cfg.stationNumber > 64) errors.push(this.validationError('stationNumber', 'Station number must be 1-64'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object', title: 'CC-Link Configuration', required: ['stationNumber'],
      properties: {
        stationNumber: { type: 'integer', title: 'Station Number', minimum: 1, maximum: 64, 'ui:order': 1, 'ui:group': 'connection' },
        baudRate: { type: 'integer', title: 'Baud Rate', enum: [156000, 625000, 2500000, 5000000, 10000000], default: 10000000, 'ui:order': 2, 'ui:group': 'connection' },
        version: { type: 'string', title: 'CC-Link Version', enum: ['Ver.1', 'Ver.2'], default: 'Ver.2', 'ui:order': 3, 'ui:group': 'connection' },
        occupiedStations: { type: 'integer', title: 'Occupied Stations', enum: [1, 2, 3, 4], default: 1, 'ui:order': 4, 'ui:group': 'io' },
        rxPoints: { type: 'integer', title: 'RX Points', default: 32, 'ui:order': 5, 'ui:group': 'io' },
        ryPoints: { type: 'integer', title: 'RY Points', default: 32, 'ui:order': 6, 'ui:group': 'io' },
        rwwPoints: { type: 'integer', title: 'RWw Points', default: 4, 'ui:order': 7, 'ui:group': 'io' },
        rwrPoints: { type: 'integer', title: 'RWr Points', default: 4, 'ui:order': 8, 'ui:group': 'io' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['stationNumber', 'baudRate', 'version'] },
        { name: 'io', title: 'I/O Configuration', fields: ['occupiedStations', 'rxPoints', 'ryPoints', 'rwwPoints', 'rwrPoints'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { stationNumber: 1, baudRate: 10000000, version: 'Ver.2', occupiedStations: 1, rxPoints: 32, ryPoints: 32, rwwPoints: 4, rwrPoints: 4 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: false, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BIT', 'WORD'] };
  }
}
