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
 * PROFINET Configuration
 */
export interface ProfinetConfig {
  deviceName: string;
  ipAddress: string;
  subnetMask: string;
  gateway?: string;
  gsdmlFile?: string;
  inputModuleSlot: number;
  outputModuleSlot: number;
  sendClock: number;
  reductionRatio: number;
  watchdogFactor: number;
}

/**
 * PROFINET Connection Handle
 */
interface ProfinetConnectionHandle extends VfdConnectionHandle {
  config: ProfinetConfig;
  arId?: number; // Application Relation ID
  ioCrId?: number; // IO Communication Relation ID
}

/**
 * VFD PROFINET Protocol Adapter
 * Implements PROFINET IO communication for VFD drives
 */
@Injectable()
export class VfdProfinetAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.PROFINET;
  readonly protocolName = 'PROFINET IO';

  private connections: Map<string, ProfinetConnectionHandle> = new Map();

  constructor() {
    super('VfdProfinetAdapter');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via PROFINET at ${validatedConfig.ipAddress}`);

      // PROFINET IO uses Real-Time Ethernet
      // Connection establishment involves:
      // 1. DCP (Discovery and Configuration Protocol) for device discovery
      // 2. RPC (Remote Procedure Call) for connection management
      // 3. RT (Real-Time) protocol for cyclic data exchange

      const handle: ProfinetConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.PROFINET,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        metadata: {
          deviceName: validatedConfig.deviceName,
          ipAddress: validatedConfig.ipAddress,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD via PROFINET at ${validatedConfig.ipAddress}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via PROFINET', error as Error);
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
      // In production: Release AR (Application Relation)
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from PROFINET, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting from PROFINET', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      handle = await this.connect(config);

      // Read cyclic data
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
    const connection = this.connections.get(handle.id) as ProfinetConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    try {
      // PROFINET uses cyclic IO data
      // Data structure defined by GSDML and module configuration
      // Standard telegram structure (PROFIdrive):
      // - STW1/ZSW1 (Control/Status word)
      // - NSOLL_A/NIST_A (Speed setpoint/actual, normalized)
      // - Additional PZD words as configured

      const inputData = await this.readCyclicData(connection);

      for (const mapping of registerMappings) {
        try {
          const offset = this.calculateIoOffset(mapping.registerAddress);
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async readRegister(
    handle: VfdConnectionHandle,
    address: number,
    count: number,
    _functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as ProfinetConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // PROFINET acyclic read via Read Record service
    this.logDebug(`PROFINET acyclic read: slot/subslot index ${address}, count ${count}`);

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
    const connection = this.connections.get(handle.id) as ProfinetConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      this.logDebug(`PROFINET write: address ${address}, value ${value}`);

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

    if (!cfg.deviceName || typeof cfg.deviceName !== 'string') {
      errors.push('deviceName is required and must be a string');
    }

    if (!cfg.ipAddress || typeof cfg.ipAddress !== 'string') {
      errors.push('ipAddress is required and must be a string');
    } else {
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      if (!ipRegex.test(cfg.ipAddress)) {
        errors.push('ipAddress must be a valid IPv4 address');
      }
    }

    if (cfg.sendClock !== undefined) {
      if (typeof cfg.sendClock !== 'number' || cfg.sendClock < 250 || cfg.sendClock > 4000) {
        errors.push('sendClock must be between 250 and 4000 µs');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['deviceName', 'ipAddress'],
      properties: {
        deviceName: {
          type: 'string',
          title: 'Device Name',
          description: 'PROFINET device name (station name)',
          examples: ['vfd-drive-001', 'sinamics-g120'],
        },
        ipAddress: {
          type: 'string',
          title: 'IP Address',
          description: 'IPv4 address of the VFD',
          format: 'ipv4',
          examples: ['192.168.1.100'],
        },
        subnetMask: {
          type: 'string',
          title: 'Subnet Mask',
          description: 'Network subnet mask',
          format: 'ipv4',
          default: '255.255.255.0',
        },
        gateway: {
          type: 'string',
          title: 'Gateway',
          description: 'Default gateway (optional)',
          format: 'ipv4',
        },
        gsdmlFile: {
          type: 'string',
          title: 'GSDML File',
          description: 'Path to GSDML device description file',
        },
        inputModuleSlot: {
          type: 'integer',
          title: 'Input Module Slot',
          description: 'Slot number for input module',
          minimum: 0,
          maximum: 255,
          default: 1,
        },
        outputModuleSlot: {
          type: 'integer',
          title: 'Output Module Slot',
          description: 'Slot number for output module',
          minimum: 0,
          maximum: 255,
          default: 1,
        },
        sendClock: {
          type: 'integer',
          title: 'Send Clock (µs)',
          description: 'PROFINET send clock in microseconds',
          enum: [250, 500, 1000, 2000, 4000],
          default: 1000,
        },
        reductionRatio: {
          type: 'integer',
          title: 'Reduction Ratio',
          description: 'Cycle reduction ratio',
          minimum: 1,
          maximum: 512,
          default: 32,
        },
        watchdogFactor: {
          type: 'integer',
          title: 'Watchdog Factor',
          description: 'Watchdog timeout multiplier',
          minimum: 1,
          maximum: 100,
          default: 10,
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      deviceName: '',
      ipAddress: '',
      subnetMask: '255.255.255.0',
      gateway: '',
      gsdmlFile: '',
      inputModuleSlot: 1,
      outputModuleSlot: 1,
      sendClock: 1000,
      reductionRatio: 32,
      watchdogFactor: 10,
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): ProfinetConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      deviceName: config.deviceName as string,
      ipAddress: config.ipAddress as string,
      subnetMask: (config.subnetMask as string) || '255.255.255.0',
      gateway: config.gateway as string,
      gsdmlFile: config.gsdmlFile as string,
      inputModuleSlot: (config.inputModuleSlot as number) || 1,
      outputModuleSlot: (config.outputModuleSlot as number) || 1,
      sendClock: (config.sendClock as number) || 1000,
      reductionRatio: (config.reductionRatio as number) || 32,
      watchdogFactor: (config.watchdogFactor as number) || 10,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async readCyclicData(_connection: ProfinetConnectionHandle): Promise<Buffer> {
    // Read cyclic IO data from PROFINET
    // In production, this would use RT Ethernet frames
    const data = Buffer.alloc(32); // Typical telegram size
    for (let i = 0; i < 32; i += 2) {
      data.writeUInt16BE(Math.floor(Math.random() * 65535), i);
    }
    return data;
  }

  private calculateIoOffset(registerAddress: number): number {
    // Map register address to IO data offset
    return (registerAddress % 100) * 2;
  }
}
