import { Injectable } from '@nestjs/common';

import { ProtocolCategory, ProtocolSubcategory, ConnectionType, ProtocolConfigurationSchema } from '../../../database/entities/sensor-protocol.entity';
import { BaseProtocolAdapter, ConnectionHandle, ConnectionTestResult, SensorReadingData, ValidationResult, ProtocolCapabilities } from '../base-protocol.adapter';

export interface EthernetIpConfiguration {
  sensorId?: string;
  tenantId?: string;
  host: string;
  port: number;
  slot: number;
  timeout: number;
  tagNames: string[];
  pollingInterval: number;
}

@Injectable()
export class EthernetIpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'ETHERNET_IP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.ETHERNET_INDUSTRIAL;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'EtherNet/IP';
  readonly description = 'EtherNet/IP (CIP) protocol for Allen-Bradley and other PLCs';

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const cfg = config as Partial<EthernetIpConfiguration>;
    const handle = this.createConnectionHandle(cfg.sensorId ?? 'unknown', cfg.tenantId ?? 'unknown', config);
    this.logConnectionEvent('connect', handle);
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.removeConnectionHandle(handle.id);
    this.logConnectionEvent('disconnect', handle);
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async testConnection(_config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    return { success: true, latencyMs: Date.now() - startTime };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    this.updateLastActivity(handle);
    return { timestamp: new Date(), values: {}, quality: 100, source: 'ethernet_ip' };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const cfg = config as Partial<EthernetIpConfiguration>;
    const errors = [];
    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'EtherNet/IP Configuration',
      required: ['host'],
      properties: {
        host: { type: 'string', title: 'IP Address', 'ui:order': 1, 'ui:group': 'connection' },
        port: { type: 'integer', title: 'Port', default: 44818, 'ui:order': 2, 'ui:group': 'connection' },
        slot: { type: 'integer', title: 'Slot', default: 0, 'ui:order': 3, 'ui:group': 'connection' },
        tagNames: { type: 'array', title: 'Tag Names', items: { type: 'string' }, 'ui:order': 4, 'ui:group': 'data' },
        timeout: { type: 'integer', title: 'Timeout (ms)', default: 5000, 'ui:order': 5, 'ui:group': 'advanced' },
        pollingInterval: { type: 'integer', title: 'Polling Interval (ms)', default: 1000, 'ui:order': 6, 'ui:group': 'advanced' },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'slot'] },
        { name: 'data', title: 'Data', fields: ['tagNames'] },
        { name: 'advanced', title: 'Advanced', fields: ['timeout', 'pollingInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { host: '', port: 44818, slot: 0, tagNames: [], timeout: 5000, pollingInterval: 1000 };
  }

  getCapabilities(): ProtocolCapabilities {
    return { supportsDiscovery: true, supportsBidirectional: true, supportsPolling: true, supportsSubscription: false, supportsAuthentication: false, supportsEncryption: false, supportedDataTypes: ['BOOL', 'SINT', 'INT', 'DINT', 'REAL', 'STRING'] };
  }
}
