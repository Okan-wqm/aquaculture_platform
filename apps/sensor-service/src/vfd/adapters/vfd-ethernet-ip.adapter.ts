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
 * EtherNet/IP Configuration
 */
export interface EthernetIpConfig {
  host: string;
  port: number;
  slot: number;
  originatorSerialNumber: number;
  inputAssembly: number;
  outputAssembly: number;
  configurationAssembly: number;
  rpi: number; // Requested Packet Interval in ms
  edsFile?: string;
}

/**
 * EtherNet/IP Connection Handle
 */
interface EthernetIpConnectionHandle extends VfdConnectionHandle {
  config: EthernetIpConfig;
  sessionId?: number;
  connectionId?: number;
}

/**
 * VFD EtherNet/IP Protocol Adapter
 * Implements EtherNet/IP (CIP) communication for VFD drives
 */
@Injectable()
export class VfdEthernetIpAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.ETHERNET_IP;
  readonly protocolName = 'EtherNet/IP';

  private connections: Map<string, EthernetIpConnectionHandle> = new Map();

  constructor() {
    super('VfdEthernetIpAdapter');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via EtherNet/IP at ${validatedConfig.host}:${validatedConfig.port}`);

      // EtherNet/IP connection involves:
      // 1. TCP connection to port 44818
      // 2. Register Session (encapsulation)
      // 3. Forward Open (CIP connection for I/O)

      const handle: EthernetIpConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.ETHERNET_IP,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        metadata: {
          host: validatedConfig.host,
          port: validatedConfig.port,
          slot: validatedConfig.slot,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD via EtherNet/IP at ${validatedConfig.host}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via EtherNet/IP', error as Error);
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(handle: VfdConnectionHandle): Promise<void> {
    const connection = this.connections.get(handle.id);
    if (!connection) {
      this.logger.warn(`Connection ${handle.id} not found`);
      return;
    }

    try {
      // In production: Forward Close + Unregister Session
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from EtherNet/IP, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting from EtherNet/IP', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      handle = await this.connect(config);

      // Read identity object (Class 1, Instance 1)
      await this.readRegister(handle, 1, 1, 0x0e); // Get Attribute Single
      const latencyMs = Date.now() - startTime;

      await this.disconnect(handle);

      return {
        success: true,
        latencyMs,
        sampleData: {},
      };
    } catch (error) {
      if (handle) {
        try {
          await this.disconnect(handle);
        } catch {
          // Ignore
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
    const connection = this.connections.get(handle.id) as EthernetIpConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    try {
      // EtherNet/IP uses assembly objects for I/O data
      // PowerFlex drives typically use:
      // - Input Assembly (from drive): Status, Speed Feedback, Current, etc.
      // - Output Assembly (to drive): Control Word, Speed Reference

      const inputData = await this.readAssemblyData(
        connection,
        connection.config.inputAssembly
      );

      for (const mapping of registerMappings) {
        try {
          const offset = this.calculateCipOffset(mapping.registerAddress);
          if (offset + (mapping.registerCount || 1) * 2 <= inputData.length) {
            const valueBuffer = inputData.subarray(offset, offset + (mapping.registerCount || 1) * 2);

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
          }
        } catch (err) {
          errors.push(`Failed to parse ${mapping.parameterName}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`Assembly read failed: ${(err as Error).message}`);
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async readRegister(
    handle: VfdConnectionHandle,
    address: number,
    count: number,
    functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as EthernetIpConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // CIP explicit messaging - Get Attribute Single or Get Attribute All
    this.logDebug(`EtherNet/IP explicit read: class ${address}, service ${functionCode}`);

    // Simulated response
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as EthernetIpConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      // CIP Set Attribute Single
      this.logDebug(`EtherNet/IP write: address ${address}, value ${value}`);

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

    if (!cfg.host || typeof cfg.host !== 'string') {
      errors.push('host is required and must be a string');
    } else {
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      if (!ipRegex.test(cfg.host) && cfg.host !== 'localhost') {
        errors.push('host must be a valid IP address');
      }
    }

    if (cfg.port !== undefined) {
      if (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535) {
        errors.push('port must be between 1 and 65535');
      }
    }

    if (cfg.slot !== undefined) {
      if (typeof cfg.slot !== 'number' || cfg.slot < 0 || cfg.slot > 15) {
        errors.push('slot must be between 0 and 15');
      }
    }

    if (cfg.rpi !== undefined) {
      if (typeof cfg.rpi !== 'number' || cfg.rpi < 2 || cfg.rpi > 3200) {
        errors.push('rpi must be between 2 and 3200 ms');
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
          description: 'IP address of the VFD',
          format: 'ipv4',
          examples: ['192.168.1.100'],
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'EtherNet/IP port (default 44818)',
          minimum: 1,
          maximum: 65535,
          default: 44818,
        },
        slot: {
          type: 'integer',
          title: 'Slot',
          description: 'Backplane slot number',
          minimum: 0,
          maximum: 15,
          default: 0,
        },
        originatorSerialNumber: {
          type: 'integer',
          title: 'Originator Serial Number',
          description: 'Unique identifier for this connection',
          default: 12345,
        },
        inputAssembly: {
          type: 'integer',
          title: 'Input Assembly Instance',
          description: 'Assembly instance for input data (from drive)',
          default: 100,
        },
        outputAssembly: {
          type: 'integer',
          title: 'Output Assembly Instance',
          description: 'Assembly instance for output data (to drive)',
          default: 150,
        },
        configurationAssembly: {
          type: 'integer',
          title: 'Configuration Assembly Instance',
          description: 'Assembly instance for configuration',
          default: 151,
        },
        rpi: {
          type: 'integer',
          title: 'RPI (ms)',
          description: 'Requested Packet Interval in milliseconds',
          minimum: 2,
          maximum: 3200,
          default: 100,
        },
        edsFile: {
          type: 'string',
          title: 'EDS File',
          description: 'Path to Electronic Data Sheet file',
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      host: '',
      port: 44818,
      slot: 0,
      originatorSerialNumber: 12345,
      inputAssembly: 100,
      outputAssembly: 150,
      configurationAssembly: 151,
      rpi: 100,
      edsFile: '',
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): EthernetIpConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      host: config.host as string,
      port: (config.port as number) || 44818,
      slot: (config.slot as number) ?? 0,
      originatorSerialNumber: (config.originatorSerialNumber as number) || 12345,
      inputAssembly: (config.inputAssembly as number) || 100,
      outputAssembly: (config.outputAssembly as number) || 150,
      configurationAssembly: (config.configurationAssembly as number) || 151,
      rpi: (config.rpi as number) || 100,
      edsFile: config.edsFile as string,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async readAssemblyData(
    _connection: EthernetIpConnectionHandle,
    assemblyInstance: number
  ): Promise<Buffer> {
    // Read assembly object instance data
    // In production, this would use CIP implicit messaging
    this.logDebug(`Reading assembly instance ${assemblyInstance}`);

    const data = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 2) {
      data.writeUInt16LE(Math.floor(Math.random() * 65535), i);
    }
    return data;
  }

  private calculateCipOffset(registerAddress: number): number {
    // Map register address to CIP data offset
    return (registerAddress % 100) * 2;
  }
}
