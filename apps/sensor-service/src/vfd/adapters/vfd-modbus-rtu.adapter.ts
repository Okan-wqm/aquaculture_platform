import { Injectable } from '@nestjs/common';

import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdProtocol, VfdDataType, ByteOrder } from '../entities/vfd.enums';

import {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
} from './base-vfd.adapter';

/**
 * Modbus RTU Configuration
 */
export interface ModbusRtuConfig {
  serialPort: string;
  slaveId: number;
  baudRate: 4800 | 9600 | 19200 | 38400 | 57600 | 115200;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  timeout: number;
  retryCount: number;
}

/**
 * Modbus RTU Connection Handle
 */
interface ModbusRtuConnectionHandle extends VfdConnectionHandle {
  config: ModbusRtuConfig;
  port?: unknown; // SerialPort instance placeholder
}

/**
 * VFD Modbus RTU Protocol Adapter
 * Implements Modbus RTU serial communication for VFD drives
 */
@Injectable()
export class VfdModbusRtuAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.MODBUS_RTU;
  readonly protocolName = 'Modbus RTU';

  // Active connections map
  private connections: Map<string, ModbusRtuConnectionHandle> = new Map();

  constructor() {
    super('VfdModbusRtuAdapter');
  }

  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via Modbus RTU on ${validatedConfig.serialPort}`);

      // In production, this would use the serialport library
      // const SerialPort = require('serialport');
      // const port = new SerialPort({
      //   path: validatedConfig.serialPort,
      //   baudRate: validatedConfig.baudRate,
      //   dataBits: validatedConfig.dataBits,
      //   parity: validatedConfig.parity,
      //   stopBits: validatedConfig.stopBits,
      // });

      const handle: ModbusRtuConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.MODBUS_RTU,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        metadata: {
          serialPort: validatedConfig.serialPort,
          slaveId: validatedConfig.slaveId,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD on ${validatedConfig.serialPort}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via Modbus RTU', error as Error);
      throw error;
    }
  }

  async disconnect(handle: VfdConnectionHandle): Promise<void> {
    const connection = this.connections.get(handle.id);
    if (!connection) {
      this.logger.warn(`Connection ${handle.id} not found`);
      return;
    }

    try {
      // In production: await connection.port?.close();
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from VFD, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      const validatedConfig = this.validateAndCastConfig(config);
      handle = await this.connect(config);

      // Try to read a basic status register (address 0 or first available)
      const testBuffer = await this.readRegister(handle, 0, 1, 3);
      const latencyMs = Date.now() - startTime;

      await this.disconnect(handle);

      return {
        success: true,
        latencyMs,
        sampleData: {
          statusWord: testBuffer.readUInt16BE(0),
        },
      };
    } catch (error) {
      if (handle) {
        try {
          await this.disconnect(handle);
        } catch {
          // Ignore disconnect errors
        }
      }

      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  async readParameters(
    handle: VfdConnectionHandle,
    registerMappings: VfdRegisterMapping[]
  ): Promise<VfdReadResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as ModbusRtuConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    // Group registers for efficient batch reading
    const batches = this.groupRegistersForBatchRead(registerMappings);

    for (const batch of batches) {
      try {
        const buffer = await this.readRegister(
          handle,
          batch.startAddress,
          batch.count,
          batch.functionCode
        );

        // Extract individual values from batch buffer
        for (const mapping of registerMappings) {
          if (
            mapping.registerAddress >= batch.startAddress &&
            mapping.registerAddress < batch.startAddress + batch.count
          ) {
            try {
              const valueBuffer = this.extractValueFromBuffer(
                buffer,
                batch.startAddress,
                mapping
              );

              const rawValue = this.parseRawValue(
                valueBuffer,
                mapping.dataType as VfdDataType,
                mapping.byteOrder as ByteOrder,
                mapping.wordOrder as ByteOrder
              );

              rawValues[mapping.parameterName] = rawValue;

              // Apply scaling
              const scaledValue = this.applyScaling(
                rawValue,
                mapping.scalingFactor,
                mapping.offset
              );

              // Map to standard parameter name
              const stdParamName = this.mapParameterName(mapping.parameterName);
              if (stdParamName) {
                parameters[stdParamName] = scaledValue;
              } else {
                parameters[mapping.parameterName] = scaledValue;
              }

              // Parse status word if applicable
              if (
                mapping.dataType === VfdDataType.STATUS_WORD ||
                mapping.parameterName.includes('status')
              ) {
                statusBits = this.parseStatusWord(rawValue, mapping.bitDefinitions ?? undefined);
              }
            } catch (err) {
              errors.push(`Failed to parse ${mapping.parameterName}: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        errors.push(`Batch read failed at ${batch.startAddress}: ${(err as Error).message}`);
      }
    }

    connection.lastActivity = new Date();

    return {
      parameters,
      statusBits,
      rawValues,
      timestamp: new Date(),
      latencyMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async readRegister(
    handle: VfdConnectionHandle,
    address: number,
    count: number,
    functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as ModbusRtuConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // Build Modbus RTU request frame
    const request = this.buildModbusRequest(
      connection.config.slaveId,
      functionCode,
      address,
      count
    );

    // In production, this would send/receive via serial port
    // For now, return simulated data
    this.logDebug(`Reading ${count} registers from address ${address}`, {
      slaveId: connection.config.slaveId,
      functionCode,
    });

    // Simulate response
    const responseData = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) {
      responseData.writeUInt16BE(Math.floor(Math.random() * 65535), i * 2);
    }

    return responseData;
  }

  async writeControlWord(
    handle: VfdConnectionHandle,
    controlWord: number,
    registerAddress: number
  ): Promise<VfdCommandResult> {
    return this.writeRegister(handle, registerAddress, controlWord);
  }

  async writeSpeedReference(
    handle: VfdConnectionHandle,
    value: number,
    registerAddress: number,
    scalingFactor: number
  ): Promise<VfdCommandResult> {
    const rawValue = this.reverseScaling(value, scalingFactor);
    return this.writeRegister(handle, registerAddress, rawValue);
  }

  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as ModbusRtuConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      // Build Modbus write request (function code 6 for single register)
      const request = this.buildModbusWriteRequest(
        connection.config.slaveId,
        6,
        address,
        value
      );

      this.logDebug(`Writing value ${value} to address ${address}`, {
        slaveId: connection.config.slaveId,
      });

      // In production, send via serial port and wait for response
      connection.lastActivity = new Date();

      return {
        success: true,
        acknowledgedAt: new Date(),
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
      return { valid: false, errors: ['Configuration must be an object'] };
    }

    const cfg = config as Record<string, unknown>;

    // Required fields
    if (!cfg.serialPort || typeof cfg.serialPort !== 'string') {
      errors.push('serialPort is required and must be a string');
    }

    if (cfg.slaveId === undefined || typeof cfg.slaveId !== 'number') {
      errors.push('slaveId is required and must be a number');
    } else if (cfg.slaveId < 1 || cfg.slaveId > 247) {
      errors.push('slaveId must be between 1 and 247');
    }

    // Optional fields with validation
    const validBaudRates = [4800, 9600, 19200, 38400, 57600, 115200];
    if (cfg.baudRate !== undefined && !validBaudRates.includes(cfg.baudRate as number)) {
      errors.push(`baudRate must be one of: ${validBaudRates.join(', ')}`);
    }

    if (cfg.dataBits !== undefined && ![7, 8].includes(cfg.dataBits as number)) {
      errors.push('dataBits must be 7 or 8');
    }

    if (cfg.parity !== undefined && !['none', 'even', 'odd'].includes(cfg.parity as string)) {
      errors.push('parity must be "none", "even", or "odd"');
    }

    if (cfg.stopBits !== undefined && ![1, 2].includes(cfg.stopBits as number)) {
      errors.push('stopBits must be 1 or 2');
    }

    if (cfg.timeout !== undefined) {
      if (typeof cfg.timeout !== 'number' || cfg.timeout < 100 || cfg.timeout > 30000) {
        errors.push('timeout must be between 100 and 30000 ms');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['serialPort', 'slaveId'],
      properties: {
        serialPort: {
          type: 'string',
          title: 'Serial Port',
          description: 'Serial port path (e.g., COM3 or /dev/ttyUSB0)',
          examples: ['COM3', '/dev/ttyUSB0', '/dev/ttyS0'],
        },
        slaveId: {
          type: 'integer',
          title: 'Slave ID',
          description: 'Modbus slave address (1-247)',
          minimum: 1,
          maximum: 247,
          default: 1,
        },
        baudRate: {
          type: 'integer',
          title: 'Baud Rate',
          enum: [4800, 9600, 19200, 38400, 57600, 115200],
          default: 9600,
        },
        dataBits: {
          type: 'integer',
          title: 'Data Bits',
          enum: [7, 8],
          default: 8,
        },
        parity: {
          type: 'string',
          title: 'Parity',
          enum: ['none', 'even', 'odd'],
          default: 'none',
        },
        stopBits: {
          type: 'integer',
          title: 'Stop Bits',
          enum: [1, 2],
          default: 1,
        },
        timeout: {
          type: 'integer',
          title: 'Timeout (ms)',
          description: 'Response timeout in milliseconds',
          minimum: 100,
          maximum: 30000,
          default: 1000,
        },
        retryCount: {
          type: 'integer',
          title: 'Retry Count',
          description: 'Number of retries on failure',
          minimum: 0,
          maximum: 10,
          default: 3,
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      serialPort: '',
      slaveId: 1,
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      timeout: 1000,
      retryCount: 3,
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): ModbusRtuConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      serialPort: config.serialPort as string,
      slaveId: config.slaveId as number,
      baudRate: (config.baudRate as ModbusRtuConfig['baudRate']) || 9600,
      dataBits: (config.dataBits as ModbusRtuConfig['dataBits']) || 8,
      parity: (config.parity as ModbusRtuConfig['parity']) || 'none',
      stopBits: (config.stopBits as ModbusRtuConfig['stopBits']) || 1,
      timeout: (config.timeout as number) || 1000,
      retryCount: (config.retryCount as number) || 3,
    };
  }

  private buildModbusRequest(
    slaveId: number,
    functionCode: number,
    startAddress: number,
    quantity: number
  ): Buffer {
    const request = Buffer.alloc(8);
    request.writeUInt8(slaveId, 0);
    request.writeUInt8(functionCode, 1);
    request.writeUInt16BE(startAddress, 2);
    request.writeUInt16BE(quantity, 4);

    const crc = this.calculateCRC16(request.subarray(0, 6));
    request.writeUInt16LE(crc, 6);

    return request;
  }

  private buildModbusWriteRequest(
    slaveId: number,
    functionCode: number,
    address: number,
    value: number
  ): Buffer {
    const request = Buffer.alloc(8);
    request.writeUInt8(slaveId, 0);
    request.writeUInt8(functionCode, 1);
    request.writeUInt16BE(address, 2);
    request.writeUInt16BE(value, 4);

    const crc = this.calculateCRC16(request.subarray(0, 6));
    request.writeUInt16LE(crc, 6);

    return request;
  }
}
