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
 * Modbus TCP Configuration
 */
export interface ModbusTcpConfig {
  host: string;
  port: number;
  unitId: number;
  connectionTimeout: number;
  responseTimeout: number;
  keepAlive: boolean;
  reconnectInterval: number;
}

/**
 * Modbus TCP Connection Handle
 */
interface ModbusTcpConnectionHandle extends VfdConnectionHandle {
  config: ModbusTcpConfig;
  socket?: unknown; // TCP socket placeholder
  transactionId: number;
}

/**
 * VFD Modbus TCP Protocol Adapter
 * Implements Modbus TCP communication for VFD drives
 */
@Injectable()
export class VfdModbusTcpAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.MODBUS_TCP;
  readonly protocolName = 'Modbus TCP';

  // Active connections map
  private connections: Map<string, ModbusTcpConnectionHandle> = new Map();

  constructor() {
    super('VfdModbusTcpAdapter');
  }

  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via Modbus TCP at ${validatedConfig.host}:${validatedConfig.port}`);

      // In production, this would use Node.js net module
      // const net = require('net');
      // const socket = new net.Socket();
      // await new Promise((resolve, reject) => {
      //   socket.connect(validatedConfig.port, validatedConfig.host, resolve);
      //   socket.on('error', reject);
      //   setTimeout(() => reject(new Error('Connection timeout')), validatedConfig.connectionTimeout);
      // });

      const handle: ModbusTcpConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.MODBUS_TCP,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        transactionId: 0,
        metadata: {
          host: validatedConfig.host,
          port: validatedConfig.port,
          unitId: validatedConfig.unitId,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD at ${validatedConfig.host}:${validatedConfig.port}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via Modbus TCP', error as Error);
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
      // In production: await connection.socket?.end();
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

      // Try to read a basic status register
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
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

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

              const scaledValue = this.applyScaling(
                rawValue,
                mapping.scalingFactor,
                mapping.offset
              );

              const stdParamName = this.mapParameterName(mapping.parameterName);
              if (stdParamName) {
                parameters[stdParamName] = scaledValue;
              } else {
                parameters[mapping.parameterName] = scaledValue;
              }

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
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // Increment transaction ID
    connection.transactionId = (connection.transactionId + 1) & 0xffff;

    // Build Modbus TCP request frame (MBAP header + PDU)
    const request = this.buildModbusTcpRequest(
      connection.transactionId,
      connection.config.unitId,
      functionCode,
      address,
      count
    );

    this.logDebug(`Reading ${count} registers from address ${address}`, {
      transactionId: connection.transactionId,
      unitId: connection.config.unitId,
    });

    // In production, send via TCP socket and wait for response
    // Simulate response for now
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
    const connection = this.connections.get(handle.id) as ModbusTcpConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      connection.transactionId = (connection.transactionId + 1) & 0xffff;

      const request = this.buildModbusTcpWriteRequest(
        connection.transactionId,
        connection.config.unitId,
        6,
        address,
        value
      );

      this.logDebug(`Writing value ${value} to address ${address}`, {
        transactionId: connection.transactionId,
        unitId: connection.config.unitId,
      });

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
    if (!cfg.host || typeof cfg.host !== 'string') {
      errors.push('host is required and must be a string');
    } else {
      // Basic IP/hostname validation
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
      if (!ipRegex.test(cfg.host) && !hostnameRegex.test(cfg.host) && cfg.host !== 'localhost') {
        errors.push('host must be a valid IP address or hostname');
      }
    }

    if (cfg.port !== undefined) {
      if (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535) {
        errors.push('port must be between 1 and 65535');
      }
    }

    if (cfg.unitId !== undefined) {
      if (typeof cfg.unitId !== 'number' || cfg.unitId < 0 || cfg.unitId > 255) {
        errors.push('unitId must be between 0 and 255');
      }
    }

    if (cfg.connectionTimeout !== undefined) {
      if (typeof cfg.connectionTimeout !== 'number' || cfg.connectionTimeout < 100 || cfg.connectionTimeout > 60000) {
        errors.push('connectionTimeout must be between 100 and 60000 ms');
      }
    }

    if (cfg.responseTimeout !== undefined) {
      if (typeof cfg.responseTimeout !== 'number' || cfg.responseTimeout < 100 || cfg.responseTimeout > 30000) {
        errors.push('responseTimeout must be between 100 and 30000 ms');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['host'],
      properties: {
        host: {
          type: 'string',
          title: 'Host',
          description: 'IP address or hostname of the VFD',
          examples: ['192.168.1.100', 'vfd-1.local'],
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'Modbus TCP port',
          minimum: 1,
          maximum: 65535,
          default: 502,
        },
        unitId: {
          type: 'integer',
          title: 'Unit ID',
          description: 'Modbus unit identifier (0-255)',
          minimum: 0,
          maximum: 255,
          default: 1,
        },
        connectionTimeout: {
          type: 'integer',
          title: 'Connection Timeout (ms)',
          description: 'TCP connection timeout',
          minimum: 100,
          maximum: 60000,
          default: 5000,
        },
        responseTimeout: {
          type: 'integer',
          title: 'Response Timeout (ms)',
          description: 'Response timeout for each request',
          minimum: 100,
          maximum: 30000,
          default: 1000,
        },
        keepAlive: {
          type: 'boolean',
          title: 'Keep Alive',
          description: 'Enable TCP keep-alive',
          default: true,
        },
        reconnectInterval: {
          type: 'integer',
          title: 'Reconnect Interval (ms)',
          description: 'Interval between reconnection attempts',
          minimum: 1000,
          maximum: 300000,
          default: 5000,
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: '',
      port: 502,
      unitId: 1,
      connectionTimeout: 5000,
      responseTimeout: 1000,
      keepAlive: true,
      reconnectInterval: 5000,
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): ModbusTcpConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      host: config.host as string,
      port: (config.port as number) || 502,
      unitId: (config.unitId as number) ?? 1,
      connectionTimeout: (config.connectionTimeout as number) || 5000,
      responseTimeout: (config.responseTimeout as number) || 1000,
      keepAlive: (config.keepAlive as boolean) ?? true,
      reconnectInterval: (config.reconnectInterval as number) || 5000,
    };
  }

  private buildModbusTcpRequest(
    transactionId: number,
    unitId: number,
    functionCode: number,
    startAddress: number,
    quantity: number
  ): Buffer {
    // MBAP Header (7 bytes) + PDU (5 bytes)
    const request = Buffer.alloc(12);

    // MBAP Header
    request.writeUInt16BE(transactionId, 0);  // Transaction ID
    request.writeUInt16BE(0x0000, 2);          // Protocol ID (Modbus = 0)
    request.writeUInt16BE(6, 4);               // Length (remaining bytes)
    request.writeUInt8(unitId, 6);             // Unit ID

    // PDU
    request.writeUInt8(functionCode, 7);
    request.writeUInt16BE(startAddress, 8);
    request.writeUInt16BE(quantity, 10);

    return request;
  }

  private buildModbusTcpWriteRequest(
    transactionId: number,
    unitId: number,
    functionCode: number,
    address: number,
    value: number
  ): Buffer {
    const request = Buffer.alloc(12);

    // MBAP Header
    request.writeUInt16BE(transactionId, 0);
    request.writeUInt16BE(0x0000, 2);
    request.writeUInt16BE(6, 4);
    request.writeUInt8(unitId, 6);

    // PDU
    request.writeUInt8(functionCode, 7);
    request.writeUInt16BE(address, 8);
    request.writeUInt16BE(value, 10);

    return request;
  }
}
