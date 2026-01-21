import { Injectable } from '@nestjs/common';

import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';
import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
} from '../base-protocol.adapter';

export interface SiemensS7Configuration {
  sensorId?: string;
  tenantId?: string;
  host: string;
  port: number;
  rack: number;
  slot: number;
  connectionType: 1 | 2 | 3; // PG=1, OP=2, S7Basic=3
  pduSize: number;
  timeout: number;
  // Data blocks
  dataBlocks: Array<{
    name: string;
    dbNumber: number;
    startOffset: number;
    dataType: 'BOOL' | 'BYTE' | 'WORD' | 'DWORD' | 'INT' | 'DINT' | 'REAL' | 'STRING';
    length?: number;
  }>;
  pollingInterval: number;
}

interface S7ClientData {
  client: S7Client;
  config: SiemensS7Configuration;
}

interface S7Client {
  initiateConnection: (params: Record<string, unknown>, callback: (err?: Error) => void) => void;
  dropConnection: () => void;
  setTranslationCB: (cb: (tag: string) => string) => void;
  addItems: (items: string[]) => void;
  readAllItems: (callback: (err: Error | null, data: Record<string, unknown>) => void) => void;
}

@Injectable()
export class SiemensS7Adapter extends BaseProtocolAdapter {
  readonly protocolCode = 'SIEMENS_S7';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.PLC_NATIVE;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Siemens S7';
  readonly description = 'Siemens S7 Communication Protocol for S7-300/400/1200/1500 PLCs';

  private clients = new Map<string, S7ClientData>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const s7Config = config as unknown as SiemensS7Configuration;

    // Dynamic import nodes7 library
    const nodes7 = await import('nodes7');
    const client = new nodes7.default() as S7Client;

    await new Promise<void>((resolve, reject) => {
      client.initiateConnection(
        {
          host: s7Config.host,
          port: s7Config.port,
          rack: s7Config.rack,
          slot: s7Config.slot,
          timeout: s7Config.timeout,
        },
        (err?: Error) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    const handle = this.createConnectionHandle(
      s7Config.sensorId ?? 'unknown',
      s7Config.tenantId ?? 'unknown',
      { host: s7Config.host, rack: s7Config.rack, slot: s7Config.slot }
    );

    this.clients.set(handle.id, { client, config: s7Config });
    this.logConnectionEvent('connect', handle);
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    const clientData = this.clients.get(handle.id);
    if (clientData) {
      clientData.client.dropConnection();
      this.clients.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.connect(config);
      const latencyMs = Date.now() - startTime;

      let sampleData: SensorReadingData | undefined;
      try {
        sampleData = await this.readData(handle);
      } catch {
        // Ignore read errors during connection test
      }

      return { success: true, latencyMs, sampleData };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      if (handle) await this.disconnect(handle);
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const clientData = this.clients.get(handle.id);
    if (!clientData) throw new Error('Connection not found');

    const { client, config } = clientData;
    const values: Record<string, number | string | boolean | null> = {};

    // Add items to read
    const items: Record<string, string> = {};
    for (const db of config.dataBlocks) {
      const address = this.buildS7Address(db);
      items[db.name] = address;
    }

    client.setTranslationCB((tag: string) => items[tag]);
    client.addItems(Object.keys(items));

    await new Promise<void>((resolve, reject) => {
      client.readAllItems((err: Error | null, data: Record<string, unknown>) => {
        if (err) reject(err);
        else {
          Object.assign(values, data);
          resolve();
        }
      });
    });

    this.updateLastActivity(handle);
    return { timestamp: new Date(), values, quality: 100, source: 'siemens_s7' };
  }

  private buildS7Address(db: SiemensS7Configuration['dataBlocks'][0]): string {
    const typePrefix: Record<string, string> = {
      'BOOL': 'X',
      'BYTE': 'B',
      'WORD': 'W',
      'DWORD': 'D',
      'INT': 'INT',
      'DINT': 'DINT',
      'REAL': 'REAL',
      'STRING': 'S',
    };
    return `DB${db.dbNumber},${typePrefix[db.dataType]}${db.startOffset}`;
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const cfg = config as Partial<SiemensS7Configuration>;

    if (!cfg.host) errors.push(this.validationError('host', 'IP address is required'));
    if (cfg.rack === undefined || cfg.rack < 0 || cfg.rack > 7) {
      errors.push(this.validationError('rack', 'Rack must be between 0 and 7'));
    }
    if (cfg.slot === undefined || cfg.slot < 0 || cfg.slot > 31) {
      errors.push(this.validationError('slot', 'Slot must be between 0 and 31'));
    }
    if (!cfg.dataBlocks || cfg.dataBlocks.length === 0) {
      errors.push(this.validationError('dataBlocks', 'At least one data block is required'));
    }

    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'Siemens S7 Configuration',
      required: ['host', 'rack', 'slot'],
      properties: {
        host: {
          type: 'string',
          title: 'PLC IP Address',
          'ui:placeholder': '192.168.1.1',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        port: {
          type: 'integer',
          title: 'Port',
          default: 102,
          'ui:order': 2,
          'ui:group': 'connection',
        },
        rack: {
          type: 'integer',
          title: 'Rack Number',
          description: 'S7-300:0, S7-400:0-7, S7-1200/1500:0',
          default: 0,
          minimum: 0,
          maximum: 7,
          'ui:order': 3,
          'ui:group': 'connection',
        },
        slot: {
          type: 'integer',
          title: 'Slot Number',
          description: 'S7-300:2, S7-400:3, S7-1200/1500:0-1',
          default: 2,
          minimum: 0,
          maximum: 31,
          'ui:order': 4,
          'ui:group': 'connection',
        },
        connectionType: {
          type: 'integer',
          title: 'Connection Type',
          enum: [1, 2, 3],
          enumNames: ['PG (Programming Device)', 'OP (Operator Panel)', 'S7 Basic'],
          default: 3,
          'ui:order': 5,
          'ui:group': 'connection',
        },
        pduSize: {
          type: 'integer',
          title: 'PDU Size',
          description: 'S7-1200:240, S7-1500:480, S7-300/400:960',
          default: 240,
          'ui:order': 6,
          'ui:group': 'advanced',
        },
        timeout: {
          type: 'integer',
          title: 'Timeout (ms)',
          default: 10000,
          'ui:order': 7,
          'ui:group': 'advanced',
        },
        dataBlocks: {
          type: 'array',
          title: 'Data Blocks',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', title: 'Name' },
              dbNumber: { type: 'integer', title: 'DB Number' },
              startOffset: { type: 'integer', title: 'Start Offset' },
              dataType: {
                type: 'string',
                title: 'Data Type',
                enum: ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'DINT', 'REAL', 'STRING'],
              },
            },
          },
          'ui:order': 8,
          'ui:group': 'data',
        },
        pollingInterval: {
          type: 'integer',
          title: 'Polling Interval (ms)',
          default: 1000,
          'ui:order': 9,
          'ui:group': 'polling',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'rack', 'slot', 'connectionType'] },
        { name: 'data', title: 'Data Blocks', fields: ['dataBlocks'] },
        { name: 'polling', title: 'Polling', fields: ['pollingInterval'] },
        { name: 'advanced', title: 'Advanced', fields: ['pduSize', 'timeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: '',
      port: 102,
      rack: 0,
      slot: 2,
      connectionType: 3,
      pduSize: 240,
      timeout: 10000,
      dataBlocks: [],
      pollingInterval: 1000,
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: true,
      supportsPolling: true,
      supportsSubscription: false,
      supportsAuthentication: false,
      supportsEncryption: false,
      supportedDataTypes: ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'DINT', 'REAL', 'STRING'],
    };
  }
}
