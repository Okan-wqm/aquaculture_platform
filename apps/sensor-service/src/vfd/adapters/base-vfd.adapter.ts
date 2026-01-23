import { Logger } from '@nestjs/common';

import { VfdParameters, VfdStatusBits } from '../entities/vfd-reading.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdProtocol, VfdDataType, ByteOrder } from '../entities/vfd.enums';

/**
 * Connection handle for VFD communication
 */
export interface VfdConnectionHandle {
  id: string;
  protocol: VfdProtocol;
  isConnected: boolean;
  lastActivity: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Result of reading VFD parameters
 */
export interface VfdReadResult {
  parameters: VfdParameters;
  statusBits: VfdStatusBits;
  rawValues: Record<string, number>;
  timestamp: Date;
  latencyMs: number;
  errors?: string[];
}

/**
 * Result of writing to VFD
 */
export interface VfdCommandResult {
  success: boolean;
  error?: string;
  acknowledgedAt?: Date;
  latencyMs?: number;
}

/**
 * Connection test result
 */
export interface ConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  sampleData?: VfdParameters;
  firmwareVersion?: string;
  serialNumber?: string;
}

/**
 * Protocol configuration validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Batch read request
 */
export interface BatchReadRequest {
  startAddress: number;
  count: number;
  functionCode: number;
}

/**
 * Abstract base class for all VFD protocol adapters
 */
export abstract class BaseVfdAdapter {
  protected readonly logger: Logger;

  /**
   * Protocol code this adapter handles
   */
  abstract readonly protocolCode: VfdProtocol;

  /**
   * Human-readable protocol name
   */
  abstract readonly protocolName: string;

  constructor(adapterName: string) {
    this.logger = new Logger(adapterName);
  }

  /**
   * Establish connection to VFD
   */
  abstract connect(config: Record<string, unknown>): Promise<VfdConnectionHandle>;

  /**
   * Close connection to VFD
   */
  abstract disconnect(handle: VfdConnectionHandle): Promise<void>;

  /**
   * Test connection without maintaining it
   */
  abstract testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult>;

  /**
   * Read multiple parameters from VFD
   */
  abstract readParameters(
    handle: VfdConnectionHandle,
    registerMappings: VfdRegisterMapping[]
  ): Promise<VfdReadResult>;

  /**
   * Read a single register
   */
  abstract readRegister(
    handle: VfdConnectionHandle,
    address: number,
    count: number,
    functionCode: number
  ): Promise<Buffer>;

  /**
   * Write control word to VFD
   */
  abstract writeControlWord(
    handle: VfdConnectionHandle,
    controlWord: number,
    registerAddress: number
  ): Promise<VfdCommandResult>;

  /**
   * Write speed/frequency reference
   */
  abstract writeSpeedReference(
    handle: VfdConnectionHandle,
    value: number,
    registerAddress: number,
    scalingFactor: number
  ): Promise<VfdCommandResult>;

  /**
   * Write a single register
   */
  abstract writeRegister(
    handle: VfdConnectionHandle,
    address: number,
    value: number
  ): Promise<VfdCommandResult>;

  /**
   * Validate protocol configuration
   */
  abstract validateConfiguration(config: unknown): ValidationResult;

  /**
   * Get JSON schema for protocol configuration
   */
  abstract getConfigurationSchema(): Record<string, unknown>;

  /**
   * Get default configuration values
   */
  abstract getDefaultConfiguration(): Record<string, unknown>;

  // ============ UTILITY METHODS ============

  /**
   * Parse raw value according to data type
   */
  protected parseRawValue(
    buffer: Buffer,
    dataType: VfdDataType,
    byteOrder: ByteOrder = ByteOrder.BIG,
    wordOrder: ByteOrder = ByteOrder.BIG
  ): number {
    const isBigEndian = byteOrder === ByteOrder.BIG;

    switch (dataType) {
      case VfdDataType.UINT16:
        return isBigEndian ? buffer.readUInt16BE(0) : buffer.readUInt16LE(0);

      case VfdDataType.INT16:
        return isBigEndian ? buffer.readInt16BE(0) : buffer.readInt16LE(0);

      case VfdDataType.UINT32: {
        if (buffer.length < 4) return 0;
        const high = isBigEndian ? buffer.readUInt16BE(0) : buffer.readUInt16LE(0);
        const low = isBigEndian ? buffer.readUInt16BE(2) : buffer.readUInt16LE(2);
        return wordOrder === ByteOrder.BIG
          ? (high << 16) | low
          : (low << 16) | high;
      }

      case VfdDataType.INT32: {
        if (buffer.length < 4) return 0;
        const high = isBigEndian ? buffer.readInt16BE(0) : buffer.readInt16LE(0);
        const low = isBigEndian ? buffer.readUInt16BE(2) : buffer.readUInt16LE(2);
        return wordOrder === ByteOrder.BIG
          ? (high << 16) | low
          : (low << 16) | high;
      }

      case VfdDataType.FLOAT32: {
        if (buffer.length < 4) return 0;
        return isBigEndian ? buffer.readFloatBE(0) : buffer.readFloatLE(0);
      }

      case VfdDataType.STATUS_WORD:
      case VfdDataType.CONTROL_WORD:
        return isBigEndian ? buffer.readUInt16BE(0) : buffer.readUInt16LE(0);

      default:
        return isBigEndian ? buffer.readUInt16BE(0) : buffer.readUInt16LE(0);
    }
  }

  /**
   * Apply scaling and offset to raw value
   */
  protected applyScaling(
    rawValue: number,
    scalingFactor = 1,
    offset = 0
  ): number {
    return rawValue * scalingFactor + offset;
  }

  /**
   * Convert engineering value back to raw value
   */
  protected reverseScaling(
    engineeringValue: number,
    scalingFactor = 1,
    offset = 0
  ): number {
    return Math.round((engineeringValue - offset) / scalingFactor);
  }

  /**
   * Parse status word into individual bits
   */
  protected parseStatusWord(
    value: number,
    _bitDefinitions?: { bit: number; name: string }[]
  ): VfdStatusBits {
    const statusBits: VfdStatusBits = {};

    // Common status bit mappings (CiA402 / PROFIdrive standard)
    statusBits.ready = Boolean(value & 0x0001);        // Bit 0
    statusBits.running = Boolean(value & 0x0800);      // Bit 11 (typically)
    statusBits.fault = Boolean(value & 0x0008);        // Bit 3
    statusBits.warning = Boolean(value & 0x0080);      // Bit 7
    statusBits.atSetpoint = Boolean(value & 0x0400);   // Bit 10
    statusBits.voltageEnabled = Boolean(value & 0x0010); // Bit 4
    statusBits.quickStopActive = !(value & 0x0020); // Bit 5 (inverted)
    statusBits.switchOnDisabled = Boolean(value & 0x0040); // Bit 6
    statusBits.remote = Boolean(value & 0x0200);       // Bit 9
    statusBits.targetReached = Boolean(value & 0x0400); // Bit 10
    statusBits.internalLimit = Boolean(value & 0x0800); // Bit 11

    // Determine direction from bit 11 or 15 depending on brand
    const directionBit = Boolean(value & 0x8000); // Bit 15
    statusBits.direction = directionBit ? 'reverse' : 'forward';

    return statusBits;
  }

  /**
   * Build control word from individual bits
   */
  protected buildControlWord(bits: Record<string, boolean>): number {
    let controlWord = 0;

    if (bits.switchOn) controlWord |= 0x0001;      // Bit 0
    if (bits.enableVoltage) controlWord |= 0x0002; // Bit 1
    if (bits.quickStop) controlWord |= 0x0004;     // Bit 2 (inverted logic)
    if (bits.enableOperation) controlWord |= 0x0008; // Bit 3
    if (bits.rampOutZero) controlWord |= 0x0010;   // Bit 4
    if (bits.rampHold) controlWord |= 0x0020;      // Bit 5
    if (bits.rampInZero) controlWord |= 0x0040;    // Bit 6
    if (bits.faultReset) controlWord |= 0x0080;    // Bit 7
    if (bits.reverse) controlWord |= 0x0800;       // Bit 11 - Direction

    return controlWord;
  }

  /**
   * Group register mappings into efficient batch reads
   */
  protected groupRegistersForBatchRead(
    mappings: VfdRegisterMapping[],
    maxGap = 10,
    maxBatchSize = 125
  ): BatchReadRequest[] {
    if (mappings.length === 0) return [];

    // Sort by register address
    const sorted = [...mappings].sort((a, b) => a.registerAddress - b.registerAddress);

    const batches: BatchReadRequest[] = [];
    let currentBatch: BatchReadRequest | null = null;

    for (const mapping of sorted) {
      const registerCount = mapping.registerCount || 1;
      const endAddress = mapping.registerAddress + registerCount;

      if (!currentBatch) {
        // Start new batch
        currentBatch = {
          startAddress: mapping.registerAddress,
          count: registerCount,
          functionCode: mapping.functionCode || 3,
        };
      } else {
        const gap = mapping.registerAddress - (currentBatch.startAddress + currentBatch.count);
        const newCount = endAddress - currentBatch.startAddress;

        // Check if we can extend current batch
        if (
          gap <= maxGap &&
          newCount <= maxBatchSize &&
          mapping.functionCode === currentBatch.functionCode
        ) {
          currentBatch.count = newCount;
        } else {
          // Save current batch and start new one
          batches.push(currentBatch);
          currentBatch = {
            startAddress: mapping.registerAddress,
            count: registerCount,
            functionCode: mapping.functionCode || 3,
          };
        }
      }
    }

    // Don't forget the last batch
    if (currentBatch) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Extract value from batch read buffer
   */
  protected extractValueFromBuffer(
    buffer: Buffer,
    batchStartAddress: number,
    mapping: VfdRegisterMapping
  ): Buffer {
    const offset = (mapping.registerAddress - batchStartAddress) * 2;
    const length = (mapping.registerCount || 1) * 2;

    if (offset < 0 || offset + length > buffer.length) {
      throw new Error(
        `Register ${mapping.parameterName} at address ${mapping.registerAddress} not in buffer`
      );
    }

    return buffer.subarray(offset, offset + length);
  }

  /**
   * Map parameter name to standard VfdParameters key
   */
  protected mapParameterName(parameterName: string): keyof VfdParameters | null {
    const mapping: Record<string, keyof VfdParameters> = {
      output_frequency: 'outputFrequency',
      motor_speed: 'motorSpeed',
      motor_current: 'motorCurrent',
      motor_voltage: 'motorVoltage',
      dc_bus_voltage: 'dcBusVoltage',
      output_power: 'outputPower',
      motor_torque: 'motorTorque',
      power_factor: 'powerFactor',
      energy_consumption: 'energyConsumption',
      kwh_counter: 'energyConsumption',
      kwh_accumulated: 'energyConsumption',
      accumulated_power: 'energyConsumption',
      running_hours: 'runningHours',
      running_time: 'runningHours',
      run_time: 'runningHours',
      power_on_hours: 'powerOnHours',
      power_on_time: 'powerOnHours',
      power_up_time: 'powerOnHours',
      start_count: 'startCount',
      drive_temp: 'driveTemperature',
      drive_thermal: 'driveTemperature',
      heatsink_temp: 'driveTemperature',
      igbt_temp: 'driveTemperature',
      motor_thermal: 'motorThermal',
      control_card_temp: 'controlCardTemperature',
      ambient_temp: 'ambientTemperature',
      status_word: 'statusWord',
      status_word_1: 'statusWord',
      fault_code: 'faultCode',
      current_fault: 'faultCode',
      fault_code_1: 'faultCode',
      warning_word: 'warningWord',
      warning_code: 'warningWord',
      alarm_word: 'alarmWord',
      alarm_code: 'alarmWord',
      speed_reference: 'speedReference',
      frequency_reference: 'frequencyReference',
      frequency_command: 'frequencyReference',
      speed_setpoint: 'speedReference',
    };

    return mapping[parameterName] || null;
  }

  /**
   * Generate a unique connection ID
   */
  protected generateConnectionId(): string {
    return `${this.protocolCode}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Calculate CRC16 for Modbus RTU
   */
  protected calculateCRC16(buffer: Buffer): number {
    let crc = 0xffff;

    for (let i = 0; i < buffer.length; i++) {
      crc ^= buffer[i] ?? 0;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x0001) {
          crc = (crc >> 1) ^ 0xa001;
        } else {
          crc >>= 1;
        }
      }
    }

    return crc;
  }

  /**
   * Log debug information if enabled
   */
  protected logDebug(message: string, context?: Record<string, unknown>): void {
    this.logger.debug(message, context ? JSON.stringify(context) : '');
  }

  /**
   * Log error with context
   */
  protected logError(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.logger.error(
      message,
      error?.stack,
      context ? JSON.stringify(context) : ''
    );
  }
}
