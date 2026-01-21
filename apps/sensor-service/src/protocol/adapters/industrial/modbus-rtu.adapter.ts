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

import { createModbusClient, ModbusRTUClient } from './types';

export interface ModbusRtuConfiguration {
  sensorId?: string;
  tenantId?: string;
  comPort: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 1.5 | 2;
  flowControl: 'none' | 'rtscts' | 'xonxoff';
  slaveId: number;
  registerAddress: number;
  registerCount: number;
  functionCode: 1 | 2 | 3 | 4;
  dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'boolean';
  byteOrder: 'BE' | 'LE';
  wordOrder: 'HIGH_LOW' | 'LOW_HIGH';
  scaling: number;
  offset: number;
  timeout: number;
  pollingInterval: number;
}

interface ModbusRtuClientData {
  client: ModbusRTUClient;
  config: ModbusRtuConfiguration;
}

@Injectable()
export class ModbusRtuAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'MODBUS_RTU';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.MODBUS;
  readonly connectionType = ConnectionType.SERIAL;
  readonly displayName = 'Modbus RTU';
  readonly description = 'Modbus RTU over serial RS-232/RS-485';

  private clients = new Map<string, ModbusRtuClientData>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const rtuConfig = config as Partial<ModbusRtuConfiguration>;

    const client = await createModbusClient();

    await client.connectRTUBuffered(rtuConfig.comPort ?? '', {
      baudRate: rtuConfig.baudRate ?? 9600,
      dataBits: rtuConfig.dataBits ?? 8,
      parity: rtuConfig.parity ?? 'none',
      stopBits: rtuConfig.stopBits ?? 1,
    });

    client.setID(rtuConfig.slaveId ?? 1);
    client.setTimeout(rtuConfig.timeout ?? 1000);

    const handle = this.createConnectionHandle(
      rtuConfig.sensorId ?? 'unknown',
      rtuConfig.tenantId ?? 'unknown',
      { comPort: rtuConfig.comPort, slaveId: rtuConfig.slaveId }
    );

    this.clients.set(handle.id, { client, config: rtuConfig as ModbusRtuConfiguration });
    this.logConnectionEvent('connect', handle);
    return handle;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: ConnectionHandle): Promise<void> {
    const clientData = this.clients.get(handle.id);
    if (clientData) {
      try {
        clientData.client.close();
      } catch (e) {
        this.logger.warn('Error closing connection', e);
      }
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
        // Ignore read errors during test
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
    let data: number[];

    switch (config.functionCode) {
      case 1:
        data = (await client.readCoils(config.registerAddress, config.registerCount)).data;
        break;
      case 2:
        data = (await client.readDiscreteInputs(config.registerAddress, config.registerCount)).data;
        break;
      case 3:
        data = (await client.readHoldingRegisters(config.registerAddress, config.registerCount)).data;
        break;
      case 4:
        data = (await client.readInputRegisters(config.registerAddress, config.registerCount)).data;
        break;
      default:
        throw new Error(`Unsupported function code: ${String(config.functionCode)}`);
    }

    const value = this.parseData(data, config);
    this.updateLastActivity(handle);

    return {
      timestamp: new Date(),
      values: { value: (value * config.scaling) + config.offset },
      quality: 100,
      source: 'modbus_rtu',
    };
  }

  private parseData(data: number[], config: ModbusRtuConfiguration): number {
    if (!data || data.length === 0) return 0;

    const buffer = Buffer.alloc(data.length * 2);
    data.forEach((val, i) => {
      if (config.byteOrder === 'BE') {
        buffer.writeUInt16BE(val, i * 2);
      } else {
        buffer.writeUInt16LE(val, i * 2);
      }
    });

    switch (config.dataType) {
      case 'int16': return buffer.readInt16BE(0);
      case 'uint16': return buffer.readUInt16BE(0);
      case 'int32': return buffer.readInt32BE(0);
      case 'uint32': return buffer.readUInt32BE(0);
      case 'float32': return buffer.readFloatBE(0);
      case 'boolean': return data[0] ? 1 : 0;
      default: return data[0] ?? 0;
    }
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const cfg = config as Partial<ModbusRtuConfiguration>;

    if (!cfg.comPort) {
      errors.push(this.validationError('comPort', 'COM Port is required'));
    }

    if (cfg.slaveId === undefined || cfg.slaveId < 1 || cfg.slaveId > 247) {
      errors.push(this.validationError('slaveId', 'Slave ID must be between 1 and 247'));
    }

    if (cfg.baudRate && ![4800, 9600, 19200, 38400, 57600, 115200].includes(cfg.baudRate)) {
      errors.push(this.validationError('baudRate', 'Invalid baud rate'));
    }

    return { isValid: errors.length === 0, errors };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'Modbus RTU Configuration',
      required: ['comPort', 'slaveId', 'registerAddress'],
      properties: {
        comPort: {
          type: 'string',
          title: 'COM Port',
          description: 'Serial port name (COM1, /dev/ttyUSB0)',
          'ui:placeholder': 'COM1',
          'ui:order': 1,
          'ui:group': 'serial',
        },
        baudRate: {
          type: 'integer',
          title: 'Baud Rate',
          enum: [4800, 9600, 19200, 38400, 57600, 115200],
          default: 9600,
          'ui:order': 2,
          'ui:group': 'serial',
        },
        dataBits: {
          type: 'integer',
          title: 'Data Bits',
          enum: [7, 8],
          default: 8,
          'ui:order': 3,
          'ui:group': 'serial',
        },
        parity: {
          type: 'string',
          title: 'Parity',
          enum: ['none', 'even', 'odd'],
          default: 'none',
          'ui:order': 4,
          'ui:group': 'serial',
        },
        stopBits: {
          type: 'number',
          title: 'Stop Bits',
          enum: [1, 1.5, 2],
          default: 1,
          'ui:order': 5,
          'ui:group': 'serial',
        },
        flowControl: {
          type: 'string',
          title: 'Flow Control',
          enum: ['none', 'rtscts', 'xonxoff'],
          enumNames: ['None', 'RTS/CTS', 'XON/XOFF'],
          default: 'none',
          'ui:order': 6,
          'ui:group': 'serial',
        },
        slaveId: {
          type: 'integer',
          title: 'Slave ID',
          default: 1,
          minimum: 1,
          maximum: 247,
          'ui:order': 7,
          'ui:group': 'modbus',
        },
        functionCode: {
          type: 'integer',
          title: 'Function Code',
          enum: [1, 2, 3, 4],
          enumNames: ['01 - Coils', '02 - Discrete Inputs', '03 - Holding Registers', '04 - Input Registers'],
          default: 3,
          'ui:order': 8,
          'ui:group': 'modbus',
        },
        registerAddress: {
          type: 'integer',
          title: 'Register Address',
          default: 0,
          minimum: 0,
          maximum: 65535,
          'ui:order': 9,
          'ui:group': 'modbus',
        },
        registerCount: {
          type: 'integer',
          title: 'Register Count',
          default: 1,
          minimum: 1,
          maximum: 125,
          'ui:order': 10,
          'ui:group': 'modbus',
        },
        dataType: {
          type: 'string',
          title: 'Data Type',
          enum: ['int16', 'uint16', 'int32', 'uint32', 'float32', 'boolean'],
          default: 'uint16',
          'ui:order': 11,
          'ui:group': 'data',
        },
        byteOrder: {
          type: 'string',
          title: 'Byte Order',
          enum: ['BE', 'LE'],
          enumNames: ['Big Endian', 'Little Endian'],
          default: 'BE',
          'ui:order': 12,
          'ui:group': 'data',
        },
        scaling: {
          type: 'number',
          title: 'Scaling',
          default: 1,
          'ui:order': 13,
          'ui:group': 'data',
        },
        timeout: {
          type: 'integer',
          title: 'Timeout (ms)',
          default: 1000,
          'ui:order': 14,
          'ui:group': 'advanced',
        },
        pollingInterval: {
          type: 'integer',
          title: 'Polling Interval (ms)',
          default: 1000,
          'ui:order': 15,
          'ui:group': 'advanced',
        },
      },
      'ui:groups': [
        { name: 'serial', title: 'Serial Port', fields: ['comPort', 'baudRate', 'dataBits', 'parity', 'stopBits', 'flowControl'] },
        { name: 'modbus', title: 'Modbus', fields: ['slaveId', 'functionCode', 'registerAddress', 'registerCount'] },
        { name: 'data', title: 'Data Format', fields: ['dataType', 'byteOrder', 'scaling'] },
        { name: 'advanced', title: 'Advanced', fields: ['timeout', 'pollingInterval'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      comPort: '',
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
      slaveId: 1,
      functionCode: 3,
      registerAddress: 0,
      registerCount: 1,
      dataType: 'uint16',
      byteOrder: 'BE',
      wordOrder: 'HIGH_LOW',
      scaling: 1,
      offset: 0,
      timeout: 1000,
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
      supportedDataTypes: ['int16', 'uint16', 'int32', 'uint32', 'float32', 'boolean'],
      minimumPollingIntervalMs: 50,
    };
  }
}
