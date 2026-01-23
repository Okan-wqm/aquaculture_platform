import { Injectable } from '@nestjs/common';

import {
  ConnectionType,
  ProtocolCategory,
  ProtocolConfigurationSchema,
  ProtocolSubcategory,
} from '../../../database/entities/sensor-protocol.entity';
import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  ProtocolCapabilities,
  SensorReadingData,
  ValidationResult,
} from '../base-protocol.adapter';

import { createModbusClient, ModbusRTUClient } from './types';

export interface ModbusTcpConfiguration {
  host: string;
  port: number;
  unitId: number;
  // Register settings
  registerAddress: number;
  registerCount: number;
  functionCode: 1 | 2 | 3 | 4; // 1=Coils, 2=Discrete Inputs, 3=Holding Registers, 4=Input Registers
  // Data interpretation
  dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64' | 'boolean';
  byteOrder: 'BE' | 'LE'; // Big Endian or Little Endian
  wordOrder: 'HIGH_LOW' | 'LOW_HIGH'; // For 32-bit values
  scaling: number;
  offset: number;
  // Connection
  timeout: number;
  reconnectDelay: number;
  pollingInterval: number;
  // Multiple registers
  registers?: Array<{
    name: string;
    address: number;
    count: number;
    functionCode: number;
    dataType: string;
    scaling?: number;
  }>;
}

@Injectable()
export class ModbusTcpAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'MODBUS_TCP';
  readonly category = ProtocolCategory.INDUSTRIAL;
  readonly subcategory = ProtocolSubcategory.MODBUS;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'Modbus TCP/IP';
  readonly description = 'Modbus TCP/IP protocol for industrial automation and SCADA systems';

  private clients = new Map<string, { client: ModbusRTUClient; config: ModbusTcpConfiguration }>();

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const modbusConfig = config as unknown as ModbusTcpConfiguration;

    // Create typed Modbus client
    const client = await createModbusClient();

    await this.withTimeout(
      client.connectTCP(modbusConfig.host, { port: modbusConfig.port }),
      modbusConfig.timeout || 10000,
      'Connection timeout'
    );

    client.setID(modbusConfig.unitId);
    client.setTimeout(modbusConfig.timeout || 5000);

    const handle = this.createConnectionHandle(
      config.sensorId as string || 'unknown',
      config.tenantId as string || 'unknown',
      { host: modbusConfig.host, port: modbusConfig.port, unitId: modbusConfig.unitId }
    );

    this.clients.set(handle.id, { client, config: modbusConfig });
    this.logConnectionEvent('connect', handle, { host: modbusConfig.host, unitId: modbusConfig.unitId });
    return handle;
  }

  disconnect(handle: ConnectionHandle): void {
    const clientData = this.clients.get(handle.id);
    if (clientData) {
      try {
        clientData.client.close();
      } catch (e) {
        this.logger.warn('Error closing Modbus connection', e);
      }
      this.clients.delete(handle.id);
      this.removeConnectionHandle(handle.id);
      this.logConnectionEvent('disconnect', handle);
    }
  }

  isConnected(handle: ConnectionHandle): boolean {
    const clientData = this.clients.get(handle.id);
    return clientData?.client?.isOpen || false;
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: ConnectionHandle | null = null;

    try {
      handle = await this.withTimeout(this.connect(config), 15000, 'Connection timeout');
      const latencyMs = Date.now() - startTime;

      // Try to read sample data
      let sampleData: SensorReadingData | undefined;
      try {
        sampleData = await this.withTimeout(this.readData(handle), 5000, 'Read timeout');
      } catch {
        // Sample data is optional
      }

      return {
        success: true,
        latencyMs,
        sampleData,
        diagnostics: {
          connectionTimeMs: latencyMs,
          deviceInfo: {
            host: (config as unknown as ModbusTcpConfiguration).host,
            port: (config as unknown as ModbusTcpConfiguration).port,
            unitId: (config as unknown as ModbusTcpConfiguration).unitId,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      if (handle) this.disconnect(handle);
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const clientData = this.clients.get(handle.id);
    if (!clientData) throw new Error('Connection not found');

    const { client, config } = clientData;
    const timestamp = new Date();
    const values: Record<string, number | string | boolean | null> = {};

    // Read multiple registers if configured
    if (config.registers && config.registers.length > 0) {
      for (const reg of config.registers) {
        try {
          const data = await this.readRegister(client, reg.address, reg.count, reg.functionCode);
          const value = this.parseRegisterData(data, reg.dataType, config.byteOrder, config.wordOrder);
          values[reg.name] = reg.scaling ? value * reg.scaling : value;
        } catch (error) {
          this.logger.warn(`Failed to read register ${reg.name}`, error);
          values[reg.name] = null;
        }
      }
    } else {
      // Read single register
      const data = await this.readRegister(client, config.registerAddress, config.registerCount, config.functionCode);
      const value = this.parseRegisterData(data, config.dataType, config.byteOrder, config.wordOrder);
      values.value = (value * config.scaling) + config.offset;
    }

    this.updateLastActivity(handle);
    return { timestamp, values, quality: 100, source: 'modbus_tcp' };
  }

  private async readRegister(client: ModbusRTUClient, address: number, count: number, functionCode: number): Promise<number[]> {
    switch (functionCode) {
      case 1:
        return (await client.readCoils(address, count)).data as number[];
      case 2:
        return (await client.readDiscreteInputs(address, count)).data as number[];
      case 3:
        return (await client.readHoldingRegisters(address, count)).data as number[];
      case 4:
        return (await client.readInputRegisters(address, count)).data as number[];
      default:
        throw new Error(`Unsupported function code: ${functionCode}`);
    }
  }

  private parseRegisterData(
    data: number[],
    dataType: ModbusTcpConfiguration['dataType'],
    byteOrder: string,
    wordOrder: string
  ): number {
    if (!data || data.length === 0) return 0;

    const buffer = Buffer.alloc(data.length * 2);
    data.forEach((val, i) => {
      if (byteOrder === 'BE') {
        buffer.writeUInt16BE(val, i * 2);
      } else {
        buffer.writeUInt16LE(val, i * 2);
      }
    });

    // Handle word order for 32-bit values
    if (data.length >= 2 && wordOrder === 'LOW_HIGH') {
      const temp = buffer.readUInt16BE(0);
      buffer.writeUInt16BE(buffer.readUInt16BE(2), 0);
      buffer.writeUInt16BE(temp, 2);
    }

    switch (dataType) {
      case 'int16':
        return buffer.readInt16BE(0);
      case 'uint16':
        return buffer.readUInt16BE(0);
      case 'int32':
        return buffer.readInt32BE(0);
      case 'uint32':
        return buffer.readUInt32BE(0);
      case 'float32':
        return buffer.readFloatBE(0);
      case 'float64':
        return buffer.readDoubleBE(0);
      case 'boolean':
        return data[0] ? 1 : 0;
      default:
        return data[0] ?? 0;
    }
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors: Array<{ field: string; message: string; code?: string }> = [];
    const warnings: Array<{ field: string; message: string; code?: string }> = [];
    const cfg = config as Partial<ModbusTcpConfiguration>;

    if (!cfg.host) {
      errors.push(this.validationError('host', 'Host/IP address is required'));
    } else if (!this.isValidIpAddress(cfg.host) && !/^[a-zA-Z0-9.-]+$/.test(cfg.host)) {
      errors.push(this.validationError('host', 'Invalid host or IP address'));
    }

    if (cfg.port !== undefined && !this.isValidPort(cfg.port)) {
      errors.push(this.validationError('port', 'Port must be between 1 and 65535'));
    }

    if (cfg.unitId === undefined || cfg.unitId < 1 || cfg.unitId > 247) {
      errors.push(this.validationError('unitId', 'Unit ID must be between 1 and 247'));
    }

    if (cfg.registerAddress !== undefined && (cfg.registerAddress < 0 || cfg.registerAddress > 65535)) {
      errors.push(this.validationError('registerAddress', 'Register address must be between 0 and 65535'));
    }

    if (cfg.registerCount !== undefined && (cfg.registerCount < 1 || cfg.registerCount > 125)) {
      errors.push(this.validationError('registerCount', 'Register count must be between 1 and 125'));
    }

    if (cfg.functionCode !== undefined && ![1, 2, 3, 4].includes(cfg.functionCode)) {
      errors.push(this.validationError('functionCode', 'Function code must be 1, 2, 3, or 4'));
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'Modbus TCP Configuration',
      required: ['host', 'unitId', 'registerAddress'],
      properties: {
        host: {
          type: 'string',
          title: 'IP Address / Hostname',
          description: 'Modbus device IP address or hostname',
          'ui:placeholder': '192.168.1.100',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        port: {
          type: 'integer',
          title: 'Port',
          default: 502,
          minimum: 1,
          maximum: 65535,
          'ui:order': 2,
          'ui:group': 'connection',
        },
        unitId: {
          type: 'integer',
          title: 'Unit ID (Slave Address)',
          description: 'Modbus slave address (1-247)',
          default: 1,
          minimum: 1,
          maximum: 247,
          'ui:order': 3,
          'ui:group': 'connection',
        },
        timeout: {
          type: 'integer',
          title: 'Timeout (ms)',
          default: 5000,
          minimum: 100,
          'ui:order': 4,
          'ui:group': 'connection',
        },
        functionCode: {
          type: 'integer',
          title: 'Function Code',
          description: '1=Coils, 2=Discrete Inputs, 3=Holding Registers, 4=Input Registers',
          enum: [1, 2, 3, 4],
          enumNames: [
            '01 - Read Coils',
            '02 - Read Discrete Inputs',
            '03 - Read Holding Registers',
            '04 - Read Input Registers',
          ],
          default: 3,
          'ui:order': 5,
          'ui:group': 'register',
        },
        registerAddress: {
          type: 'integer',
          title: 'Register Start Address',
          description: 'Starting register address (0-65535)',
          default: 0,
          minimum: 0,
          maximum: 65535,
          'ui:order': 6,
          'ui:group': 'register',
        },
        registerCount: {
          type: 'integer',
          title: 'Register Count',
          description: 'Number of registers to read',
          default: 1,
          minimum: 1,
          maximum: 125,
          'ui:order': 7,
          'ui:group': 'register',
        },
        dataType: {
          type: 'string',
          title: 'Data Type',
          enum: ['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64', 'boolean'],
          enumNames: ['Signed 16-bit', 'Unsigned 16-bit', 'Signed 32-bit', 'Unsigned 32-bit', 'Float 32-bit', 'Float 64-bit', 'Boolean'],
          default: 'uint16',
          'ui:order': 8,
          'ui:group': 'data',
        },
        byteOrder: {
          type: 'string',
          title: 'Byte Order',
          enum: ['BE', 'LE'],
          enumNames: ['Big Endian (AB)', 'Little Endian (BA)'],
          default: 'BE',
          'ui:order': 9,
          'ui:group': 'data',
        },
        wordOrder: {
          type: 'string',
          title: 'Word Order',
          description: 'For 32-bit values',
          enum: ['HIGH_LOW', 'LOW_HIGH'],
          enumNames: ['High-Low (AB CD)', 'Low-High (CD AB)'],
          default: 'HIGH_LOW',
          'ui:order': 10,
          'ui:group': 'data',
        },
        scaling: {
          type: 'number',
          title: 'Scaling Factor',
          description: 'Multiply raw value by this factor',
          default: 1,
          'ui:order': 11,
          'ui:group': 'data',
        },
        offset: {
          type: 'number',
          title: 'Offset',
          description: 'Add to scaled value',
          default: 0,
          'ui:order': 12,
          'ui:group': 'data',
        },
        pollingInterval: {
          type: 'integer',
          title: 'Polling Interval (ms)',
          default: 1000,
          minimum: 100,
          'ui:order': 13,
          'ui:group': 'polling',
        },
        reconnectDelay: {
          type: 'integer',
          title: 'Reconnect Delay (ms)',
          default: 5000,
          'ui:order': 14,
          'ui:group': 'polling',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['host', 'port', 'unitId', 'timeout'] },
        { name: 'register', title: 'Register', fields: ['functionCode', 'registerAddress', 'registerCount'] },
        { name: 'data', title: 'Data Format', fields: ['dataType', 'byteOrder', 'wordOrder', 'scaling', 'offset'] },
        { name: 'polling', title: 'Polling', fields: ['pollingInterval', 'reconnectDelay'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: '',
      port: 502,
      unitId: 1,
      functionCode: 3,
      registerAddress: 0,
      registerCount: 1,
      dataType: 'uint16',
      byteOrder: 'BE',
      wordOrder: 'HIGH_LOW',
      scaling: 1,
      offset: 0,
      timeout: 5000,
      pollingInterval: 1000,
      reconnectDelay: 5000,
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
      supportedDataTypes: ['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64', 'boolean'],
      minimumPollingIntervalMs: 100,
      maxConnectionsPerInstance: 100,
    };
  }
}
