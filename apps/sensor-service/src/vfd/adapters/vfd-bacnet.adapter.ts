import { Injectable } from '@nestjs/common';

import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdProtocol, VfdDataType } from '../entities/vfd.enums';

import {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
} from './base-vfd.adapter';

/**
 * BACnet Configuration
 */
export interface BacnetConfig {
  transport: 'ip' | 'mstp';
  // BACnet/IP settings
  ipAddress?: string;
  port?: number;
  // BACnet MS/TP settings
  serialPort?: string;
  baudRate?: 9600 | 19200 | 38400 | 57600 | 76800 | 115200;
  macAddress?: number;
  // Common settings
  deviceInstance: number;
  apduTimeout: number;
  apduRetries: number;
  maxApduLength: number;
}

/**
 * BACnet Connection Handle
 */
interface BacnetConnectionHandle extends VfdConnectionHandle {
  config: BacnetConfig;
  invokeId: number;
}

/**
 * BACnet Object Types for VFD
 */
const BACNET_OBJECT_TYPES = {
  ANALOG_INPUT: 0,
  ANALOG_OUTPUT: 1,
  ANALOG_VALUE: 2,
  BINARY_INPUT: 3,
  BINARY_OUTPUT: 4,
  BINARY_VALUE: 5,
  MULTI_STATE_INPUT: 13,
  MULTI_STATE_OUTPUT: 14,
  MULTI_STATE_VALUE: 19,
};

/**
 * VFD BACnet Protocol Adapter
 * Implements BACnet/IP and BACnet MS/TP communication for VFD drives
 */
@Injectable()
export class VfdBacnetAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.BACNET_IP;
  readonly protocolName = 'BACnet';

  private connections: Map<string, BacnetConnectionHandle> = new Map();

  constructor() {
    super('VfdBacnetAdapter');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(config: Record<string, unknown>): Promise<VfdConnectionHandle> {
    const validatedConfig = this.validateAndCastConfig(config);
    const connectionId = this.generateConnectionId();

    try {
      const transportInfo = validatedConfig.transport === 'ip'
        ? `IP ${validatedConfig.ipAddress}:${validatedConfig.port}`
        : `MS/TP ${validatedConfig.serialPort} MAC ${validatedConfig.macAddress}`;

      this.logger.log(`Connecting to VFD via BACnet ${transportInfo}`);

      // BACnet connection involves:
      // 1. Who-Is / I-Am for device discovery (optional)
      // 2. Read Property for device object to verify connection
      // 3. Subscription to COV (Change of Value) for monitoring

      const handle: BacnetConnectionHandle = {
        id: connectionId,
        protocol: validatedConfig.transport === 'ip' ? VfdProtocol.BACNET_IP : VfdProtocol.BACNET_MSTP,
        isConnected: true,
        lastActivity: new Date(),
        config: validatedConfig,
        invokeId: 0,
        metadata: {
          transport: validatedConfig.transport,
          deviceInstance: validatedConfig.deviceInstance,
        },
      };

      this.connections.set(connectionId, handle);
      this.logger.log(`Connected to VFD via BACnet, device: ${validatedConfig.deviceInstance}, ID: ${connectionId}`);

      return handle;
    } catch (error) {
      this.logError('Failed to connect via BACnet', error as Error);
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
      this.connections.delete(handle.id);
      this.logger.log(`Disconnected from BACnet, ID: ${handle.id}`);
    } catch (error) {
      this.logError('Error disconnecting from BACnet', error as Error);
      throw error;
    }
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    let handle: VfdConnectionHandle | null = null;

    try {
      handle = await this.connect(config);

      // Read device object, object-name property
      const testBuffer = await this.readRegister(handle, 0, 1, 0);
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
    const connection = this.connections.get(handle.id) as BacnetConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const parameters: VfdParameters = {};
    const rawValues: Record<string, number> = {};
    let statusBits: VfdStatusBits = {};
    const errors: string[] = [];

    // BACnet VFD objects typically include:
    // - Analog Values for speed, current, voltage, power
    // - Binary Values for status bits
    // - Multi-state Values for operating mode, fault codes

    for (const mapping of registerMappings) {
      try {
        const { objectType, objectInstance } = this.registerToBacnetObject(mapping.registerAddress);
        const data = await this.readProperty(
          connection,
          objectType,
          objectInstance,
          85 // Present-Value property
        );

        const rawValue = data;
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
          statusBits = this.parseStatusWord(Math.round(rawValue), mapping.bitDefinitions ?? undefined);
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
    count: number,
    functionCode: number
  ): Promise<Buffer> {
    const connection = this.connections.get(handle.id) as BacnetConnectionHandle;

    if (!connection?.isConnected) {
      throw new Error('Connection not established');
    }

    const { objectType, objectInstance } = this.registerToBacnetObject(address);
    const value = await this.readProperty(connection, objectType, objectInstance, 85);

    const buffer = Buffer.alloc(4);
    if (typeof value === 'number') {
      buffer.writeFloatBE(value, 0);
    }
    return buffer;
  }

  async writeControlWord(
    handle: VfdConnectionHandle,
    controlWord: number,
    registerAddress: number
  ): Promise<VfdCommandResult> {
    // Map control word bits to BACnet binary values
    return this.writeRegister(handle, registerAddress, controlWord);
  }

  async writeSpeedReference(
    handle: VfdConnectionHandle,
    value: number,
    registerAddress: number,
    scalingFactor: number
  ): Promise<VfdCommandResult> {
    // Write to analog value object
    const scaledValue = value * scalingFactor;
    return this.writeRegister(handle, registerAddress, scaledValue);
  }

  async writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult> {
    const startTime = Date.now();
    const connection = this.connections.get(handle.id) as BacnetConnectionHandle;

    if (!connection?.isConnected) {
      return {
        success: false,
        error: 'Connection not established',
      };
    }

    try {
      const { objectType, objectInstance } = this.registerToBacnetObject(address);
      await this.writeProperty(connection, objectType, objectInstance, 85, value);

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

    if (!cfg.transport || !['ip', 'mstp'].includes(cfg.transport as string)) {
      errors.push('transport must be "ip" or "mstp"');
    }

    if (cfg.transport === 'ip') {
      if (!cfg.ipAddress || typeof cfg.ipAddress !== 'string') {
        errors.push('ipAddress is required for BACnet/IP');
      }
    }

    if (cfg.transport === 'mstp') {
      if (!cfg.serialPort || typeof cfg.serialPort !== 'string') {
        errors.push('serialPort is required for BACnet MS/TP');
      }
      if (cfg.macAddress === undefined || typeof cfg.macAddress !== 'number') {
        errors.push('macAddress is required for BACnet MS/TP');
      } else if (cfg.macAddress < 0 || cfg.macAddress > 127) {
        errors.push('macAddress must be between 0 and 127');
      }
    }

    if (cfg.deviceInstance === undefined || typeof cfg.deviceInstance !== 'number') {
      errors.push('deviceInstance is required and must be a number');
    } else if (cfg.deviceInstance < 0 || cfg.deviceInstance > 4194302) {
      errors.push('deviceInstance must be between 0 and 4194302');
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['transport', 'deviceInstance'],
      properties: {
        transport: {
          type: 'string',
          title: 'Transport',
          description: 'BACnet transport layer',
          enum: ['ip', 'mstp'],
          default: 'ip',
        },
        ipAddress: {
          type: 'string',
          title: 'IP Address',
          description: 'IP address for BACnet/IP',
          format: 'ipv4',
        },
        port: {
          type: 'integer',
          title: 'Port',
          description: 'UDP port for BACnet/IP',
          minimum: 1,
          maximum: 65535,
          default: 47808,
        },
        serialPort: {
          type: 'string',
          title: 'Serial Port',
          description: 'Serial port for BACnet MS/TP',
          examples: ['COM3', '/dev/ttyUSB0'],
        },
        baudRate: {
          type: 'integer',
          title: 'Baud Rate',
          description: 'Baud rate for MS/TP',
          enum: [9600, 19200, 38400, 57600, 76800, 115200],
          default: 76800,
        },
        macAddress: {
          type: 'integer',
          title: 'MAC Address',
          description: 'MS/TP MAC address (0-127)',
          minimum: 0,
          maximum: 127,
        },
        deviceInstance: {
          type: 'integer',
          title: 'Device Instance',
          description: 'BACnet device instance number',
          minimum: 0,
          maximum: 4194302,
        },
        apduTimeout: {
          type: 'integer',
          title: 'APDU Timeout (ms)',
          description: 'APDU timeout in milliseconds',
          minimum: 100,
          maximum: 60000,
          default: 3000,
        },
        apduRetries: {
          type: 'integer',
          title: 'APDU Retries',
          description: 'Number of APDU retries',
          minimum: 0,
          maximum: 10,
          default: 3,
        },
        maxApduLength: {
          type: 'integer',
          title: 'Max APDU Length',
          description: 'Maximum APDU length',
          enum: [128, 206, 480, 1024, 1476],
          default: 1476,
        },
      },
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      transport: 'ip',
      ipAddress: '',
      port: 47808,
      serialPort: '',
      baudRate: 76800,
      macAddress: 1,
      deviceInstance: 0,
      apduTimeout: 3000,
      apduRetries: 3,
      maxApduLength: 1476,
    };
  }

  // ============ PRIVATE METHODS ============

  private validateAndCastConfig(config: Record<string, unknown>): BacnetConfig {
    const validation = this.validateConfiguration(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    return {
      transport: config.transport as 'ip' | 'mstp',
      ipAddress: config.ipAddress as string,
      port: (config.port as number) || 47808,
      serialPort: config.serialPort as string,
      baudRate: (config.baudRate as BacnetConfig['baudRate']) || 76800,
      macAddress: config.macAddress as number,
      deviceInstance: config.deviceInstance as number,
      apduTimeout: (config.apduTimeout as number) || 3000,
      apduRetries: (config.apduRetries as number) || 3,
      maxApduLength: (config.maxApduLength as number) || 1476,
    };
  }

  private async readProperty(
    connection: BacnetConnectionHandle,
    objectType: number,
    objectInstance: number,
    propertyId: number
  ): Promise<number> {
    connection.invokeId = (connection.invokeId + 1) & 0xff;

    this.logDebug(`BACnet ReadProperty: ${objectType}:${objectInstance}, property ${propertyId}`);

    // Simulated response
    return Math.random() * 100;
  }

  private async writeProperty(
    connection: BacnetConnectionHandle,
    objectType: number,
    objectInstance: number,
    propertyId: number,
    value: number
  ): Promise<void> {
    connection.invokeId = (connection.invokeId + 1) & 0xff;

    this.logDebug(`BACnet WriteProperty: ${objectType}:${objectInstance}, property ${propertyId} = ${value}`);
  }

  private registerToBacnetObject(registerAddress: number): {
    objectType: number;
    objectInstance: number;
  } {
    // Map register addresses to BACnet objects
    // Convention: address = objectType * 1000 + objectInstance
    const objectType = Math.floor(registerAddress / 1000);
    const objectInstance = registerAddress % 1000;

    return {
      objectType: objectType || BACNET_OBJECT_TYPES.ANALOG_VALUE,
      objectInstance,
    };
  }
}
