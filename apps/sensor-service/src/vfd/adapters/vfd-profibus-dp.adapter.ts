import { Injectable } from '@nestjs/common';
import {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
} from './base-vfd.adapter';
import { VfdProtocol, VfdDataType, ByteOrder } from '../entities/vfd.enums';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';

/**
 * PROFIBUS DP Configuration
 */
export interface ProfibusConfig {
  masterAddress: number;
  slaveAddress: number;
  baudRate: 9600 | 19200 | 45450 | 93750 | 187500 | 500000 | 1500000 | 3000000 | 6000000 | 12000000;
  gsdFile?: string;
  inputLength: number;
  outputLength: number;
  timeout: number;
  interfaceType: 'serial' | 'usb' | 'pci';
  interfacePath?: string;
}

/**
 * PROFIBUS DP Connection Handle
 */
interface ProfibusConnectionHandle extends VfdConnectionHandle {
  config: ProfibusConfig;
  cycleTime: number;
}

/**
 * VFD PROFIBUS DP Protocol Adapter
 * Implements PROFIBUS DP communication for VFD drives
 */
@Injectable()
export class VfdProfibusAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.PROFIBUS_DP;
  readonly protocolName = 'PROFIBUS DP';

  private connections: Map<string, ProfibusConnectionHandle> = new Map();

  constructor() {
    super('VfdProfibusAdapter');
  }

  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via PROFIBUS DP, slave address: ${validatedConfig.slaveAddress}`);

      // PROFIBUS requires specialized hardware (master interface)
      // In production, this would interface with PROFIBUS master hardware
      // Common interfaces: HMS Anybus, Hilscher CIFX, Siemens CP cards

      const handle: ProfibusConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.PROFIBUS_DP,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        cycleTime: 0,
        metadata: {
          masterAddress: validatedConfig.masterAddress,
          slaveAddress: validatedConfig.slaveAddress,
          baudRate: validatedConfig.baudRate,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD on PROFIBUS, slave: ${validatedConfig.slaveAddress}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via PROFIBUS DP', error as Error);
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
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from PROFIBUS, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting from PROFIBUS', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      handle = await this.connect(config);

      // In PROFIBUS, we would read the diagnostic data (SAP 60)
      // or perform a device identification request
      const testBuffer = await this.readRegister(handle, 0, 2, 0);
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
    const connection = this.connections.get(handle.id) as ProfibusConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    // PROFIBUS DP uses cyclic data exchange
    // The data structure is defined by the GSD file and PPO (Parameter Process data Object) type
    // PPO types for drives: PPO1, PPO2, PPO3, PPO4, PPO5

    try {
      // Read cyclic input data
      const inputData = await this.readCyclicData(connection);

      // Parse PPO data structure
      // Typical PPO structure for drives:
      // - PZD1 (STW/ZSW): Control/Status word
      // - PZD2 (HSW/HIW): Speed setpoint/actual
      // - PKW area: Parameter channel (if available)

      for (const mapping of registerMappings) {
        try {
          const offset = this.calculatePpoOffset(mapping.registerAddress);
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
      errors.push(`Cyclic data read failed: ${(err as Error).message}`);
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
    const connection = this.connections.get(handle.id) as ProfibusConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // PROFIBUS acyclic parameter access via DPV1
    // This is used for non-cyclic parameter read/write
    this.logDebug(`PROFIBUS acyclic read: address ${address}, count ${count}`);

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

  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as ProfibusConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      this.logDebug(`PROFIBUS write: address ${address}, value ${value}`);

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

    if (cfg.slaveAddress === undefined || typeof cfg.slaveAddress !== 'number') {
      errors.push('slaveAddress is required and must be a number');
    } else if (cfg.slaveAddress < 1 || cfg.slaveAddress > 125) {
      errors.push('slaveAddress must be between 1 and 125');
    }

    if (cfg.masterAddress !== undefined) {
      if (typeof cfg.masterAddress !== 'number' || cfg.masterAddress < 0 || cfg.masterAddress > 125) {
        errors.push('masterAddress must be between 0 and 125');
      }
    }

    const validBaudRates = [9600, 19200, 45450, 93750, 187500, 500000, 1500000, 3000000, 6000000, 12000000];
    if (cfg.baudRate !== undefined && !validBaudRates.includes(cfg.baudRate as number)) {
      errors.push(`baudRate must be one of: ${validBaudRates.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['slaveAddress'],
      properties: {
        slaveAddress: {
          type: 'integer',
          title: 'Slave Address',
          description: 'PROFIBUS station address of the VFD (1-125)',
          minimum: 1,
          maximum: 125,
        },
        masterAddress: {
          type: 'integer',
          title: 'Master Address',
          description: 'PROFIBUS master station address',
          minimum: 0,
          maximum: 125,
          default: 0,
        },
        baudRate: {
          type: 'integer',
          title: 'Baud Rate',
          description: 'PROFIBUS communication speed',
          enum: [9600, 19200, 45450, 93750, 187500, 500000, 1500000, 3000000, 6000000, 12000000],
          default: 1500000,
        },
        gsdFile: {
          type: 'string',
          title: 'GSD File',
          description: 'Path to GSD (General Station Description) file',
        },
        inputLength: {
          type: 'integer',
          title: 'Input Data Length',
          description: 'Cyclic input data length in bytes',
          minimum: 2,
          maximum: 244,
          default: 12,
        },
        outputLength: {
          type: 'integer',
          title: 'Output Data Length',
          description: 'Cyclic output data length in bytes',
          minimum: 2,
          maximum: 244,
          default: 12,
        },
        timeout: {
          type: 'integer',
          title: 'Timeout (ms)',
          description: 'Communication timeout',
          minimum: 100,
          maximum: 10000,
          default: 1000,
        },
        interfaceType: {
          type: 'string',
          title: 'Interface Type',
          description: 'Type of PROFIBUS master interface',
          enum: ['serial', 'usb', 'pci'],
          default: 'usb',
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      slaveAddress: 1,
      masterAddress: 0,
      baudRate: 1500000,
      gsdFile: '',
      inputLength: 12,
      outputLength: 12,
      timeout: 1000,
      interfaceType: 'usb',
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): ProfibusConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      slaveAddress: config.slaveAddress as number,
      masterAddress: (config.masterAddress as number) ?? 0,
      baudRate: (config.baudRate as ProfibusConfig['baudRate']) || 1500000,
      gsdFile: config.gsdFile as string,
      inputLength: (config.inputLength as number) || 12,
      outputLength: (config.outputLength as number) || 12,
      timeout: (config.timeout as number) || 1000,
      interfaceType: (config.interfaceType as ProfibusConfig['interfaceType']) || 'usb',
      interfacePath: config.interfacePath as string,
    };
  }

  private async readCyclicData(connection: ProfibusConnectionHandle): Promise<Buffer> {
    // Read cyclic process data from PROFIBUS
    // This would interact with PROFIBUS master hardware
    const data = Buffer.alloc(connection.config.inputLength);
    for (let i = 0; i < connection.config.inputLength; i += 2) {
      data.writeUInt16BE(Math.floor(Math.random() * 65535), i);
    }
    return data;
  }

  private calculatePpoOffset(registerAddress: number): number {
    // Map register address to PPO offset
    // PPO structure varies by type (PPO1-PPO5)
    // This is a simplified mapping
    return (registerAddress % 100) * 2;
  }
}
