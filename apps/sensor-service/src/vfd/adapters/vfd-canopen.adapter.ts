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
 * CANopen Configuration
 */
export interface CanopenConfig {
  interface: string;
  nodeId: number;
  baudRate: 10000 | 20000 | 50000 | 125000 | 250000 | 500000 | 800000 | 1000000;
  heartbeatInterval: number;
  pdoMapping?: {
    rpdo1?: number[];
    rpdo2?: number[];
    tpdo1?: number[];
    tpdo2?: number[];
  };
  edsFile?: string;
}

/**
 * CANopen Connection Handle
 */
interface CanopenConnectionHandle extends VfdConnectionHandle {
  config: CanopenConfig;
  nmtState: 'stopped' | 'pre-operational' | 'operational';
}

/**
 * VFD CANopen Protocol Adapter
 * Implements CANopen (CiA 402 Drive Profile) communication for VFD drives
 */
@Injectable()
export class VfdCanopenAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.CANOPEN;
  readonly protocolName = 'CANopen';

  private connections: Map<string, CanopenConnectionHandle> = new Map();

  constructor() {
    super('VfdCanopenAdapter');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      this.logger.log(`Connecting to VFD via CANopen, node ID: ${validatedConfig.nodeId}`);

      // CANopen connection involves:
      // 1. CAN bus initialization
      // 2. NMT (Network Management) state machine
      // 3. SDO (Service Data Object) for configuration
      // 4. PDO (Process Data Object) for cyclic data

      const handle: CanopenConnectionHandle = {
        id: connectionId,
        protocol: VfdProtocol.CANOPEN,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        nmtState: 'operational',
        metadata: {
          interface: validatedConfig.interface,
          nodeId: validatedConfig.nodeId,
          baudRate: validatedConfig.baudRate,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD via CANopen, node: ${validatedConfig.nodeId}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via CANopen', error as Error);
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
      // In production: Send NMT stop command
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from CANopen, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting from CANopen', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      handle = await this.connect(config);

      // Read device type (Object 0x1000)
      await this.readRegister(handle, 0x1000, 1, 0);
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
    const connection = this.connections.get(handle.id) as CanopenConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    // CANopen CiA 402 Drive Profile objects:
    // - 0x6040: Controlword
    // - 0x6041: Statusword
    // - 0x6042: vl target velocity
    // - 0x6043: vl velocity demand
    // - 0x6044: vl velocity actual value
    // - 0x6077: Torque actual value
    // - 0x6078: Current actual value

    for (const mapping of registerMappings) {
      try {
        // Convert register address to CANopen object index
        const objectIndex = this.registerToCanObject(mapping.registerAddress);
        const data = await this.sdoRead(connection, objectIndex, 0);

        const rawValue = this.parseRawValue(
          data,
          mapping.dataType as VfdDataType,
          ByteOrder.LITTLE, // CANopen uses little-endian
          ByteOrder.LITTLE
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
          statusBits = this.parseCiA402StatusWord(rawValue);
        }
      } catch (err) {
        errors.push(`Failed to read ${mapping.parameterName}: ${(err as Error).message}`);
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
    _count: number,
    _functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as CanopenConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    // SDO expedited or segmented read
    return this.sdoRead(connection, address, 0);
  }

  async writeControlWord(
    handle: VfdConnectionHandle,
    controlWord: number,
    _registerAddress: number
  ): Promise<VfdCommandResult> {
    // CiA 402 controlword is at object 0x6040
    return this.writeRegister(handle, 0x6040, controlWord);
  }

  async writeSpeedReference(
    handle: VfdConnectionHandle,
    value: number,
    registerAddress: number,
    scalingFactor: number
  ): Promise<VfdCommandResult> {
    // CiA 402 target velocity is at object 0x6042
    const rawValue = this.reverseScaling(value, scalingFactor);
    return this.writeRegister(handle, 0x6042, rawValue);
  }

  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as CanopenConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      await this.sdoWrite(connection, address, 0, value);

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

    if (!cfg.interface || typeof cfg.interface !== 'string') {
      errors.push('interface is required and must be a string');
    }

    if (cfg.nodeId === undefined || typeof cfg.nodeId !== 'number') {
      errors.push('nodeId is required and must be a number');
    } else if (cfg.nodeId < 1 || cfg.nodeId > 127) {
      errors.push('nodeId must be between 1 and 127');
    }

    const validBaudRates = [10000, 20000, 50000, 125000, 250000, 500000, 800000, 1000000];
    if (cfg.baudRate !== undefined && !validBaudRates.includes(cfg.baudRate as number)) {
      errors.push(`baudRate must be one of: ${validBaudRates.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['interface', 'nodeId'],
      properties: {
        interface: {
          type: 'string',
          title: 'CAN Interface',
          description: 'CAN interface name (e.g., can0, vcan0)',
          examples: ['can0', 'vcan0', 'slcan0'],
        },
        nodeId: {
          type: 'integer',
          title: 'Node ID',
          description: 'CANopen node ID (1-127)',
          minimum: 1,
          maximum: 127,
        },
        baudRate: {
          type: 'integer',
          title: 'Baud Rate',
          description: 'CAN bus baud rate in bps',
          enum: [10000, 20000, 50000, 125000, 250000, 500000, 800000, 1000000],
          default: 250000,
        },
        heartbeatInterval: {
          type: 'integer',
          title: 'Heartbeat Interval (ms)',
          description: 'NMT heartbeat producer time',
          minimum: 0,
          maximum: 65535,
          default: 1000,
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
      interface: 'can0',
      nodeId: 1,
      baudRate: 250000,
      heartbeatInterval: 1000,
      edsFile: '',
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): CanopenConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      interface: config.interface as string,
      nodeId: config.nodeId as number,
      baudRate: (config.baudRate as CanopenConfig['baudRate']) || 250000,
      heartbeatInterval: (config.heartbeatInterval as number) || 1000,
      pdoMapping: config.pdoMapping as CanopenConfig['pdoMapping'],
      edsFile: config.edsFile as string,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async sdoRead(
    _connection: CanopenConnectionHandle,
    index: number,
    subIndex: number
  ): Promise<Buffer> {
    // SDO expedited/segmented read
    this.logDebug(`CANopen SDO read: 0x${index.toString(16)}:${subIndex}`);

    // Simulated response
    const data = Buffer.alloc(4);
    data.writeUInt32LE(Math.floor(Math.random() * 65535), 0);
    return data;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async sdoWrite(
    _connection: CanopenConnectionHandle,
    index: number,
    subIndex: number,
    value: number
  ): Promise<void> {
    // SDO expedited write
    this.logDebug(`CANopen SDO write: 0x${index.toString(16)}:${subIndex} = ${value}`);
  }

  private registerToCanObject(registerAddress: number): number {
    // Map register address to CANopen object index
    // CiA 402 standard objects start at 0x6000
    const cia402Base = 0x6000;
    return cia402Base + (registerAddress % 256);
  }

  private parseCiA402StatusWord(value: number): VfdStatusBits {
    // CiA 402 Statusword bit definitions
    return {
      ready: Boolean(value & 0x0001),           // Bit 0: Ready to switch on
      running: Boolean(value & 0x0004),         // Bit 2: Operation enabled
      fault: Boolean(value & 0x0008),           // Bit 3: Fault
      voltageEnabled: Boolean(value & 0x0010),  // Bit 4: Voltage enabled
      quickStopActive: !(value & 0x0020), // Bit 5: Quick stop (inverted)
      switchOnDisabled: Boolean(value & 0x0040), // Bit 6: Switch on disabled
      warning: Boolean(value & 0x0080),         // Bit 7: Warning
      atSetpoint: Boolean(value & 0x0400),      // Bit 10: Target reached
      internalLimit: Boolean(value & 0x0800),   // Bit 11: Internal limit active
      direction: value & 0x4000 ? 'reverse' : 'forward', // Bit 14
    };
  }
}
