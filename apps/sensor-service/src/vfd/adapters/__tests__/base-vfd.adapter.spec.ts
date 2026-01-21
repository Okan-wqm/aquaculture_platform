/**
 * Base VFD Adapter Unit Tests
 */

import { VfdRegisterMapping } from '../../entities/vfd-register-mapping.entity';
import { VfdProtocol, VfdDataType, ByteOrder } from '../../entities/vfd.enums';
import {
  BaseVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
  VfdCommandResult,
  ConnectionTestResult,
  ValidationResult,
} from '../base-vfd.adapter';

// Create a concrete implementation for testing
class TestVfdAdapter extends BaseVfdAdapter {
  readonly protocolCode = VfdProtocol.MODBUS_TCP;
  readonly protocolName = 'Test Protocol';

  constructor() {
    super('TestVfdAdapter');
  }

  async connect(): Promise<VfdConnectionHandle> {
    return {
      id: this.generateConnectionId(),
      protocol: this.protocolCode,
      isConnected: true,
      lastActivity: new Date(),
    };
  }

  async disconnect(): Promise<void> {
    // No-op for tests
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, latencyMs: 10 };
  }

  async readParameters(): Promise<VfdReadResult> {
    return {
      parameters: { outputFrequency: 50 },
      statusBits: { running: true },
      rawValues: {},
      timestamp: new Date(),
      latencyMs: 10,
    };
  }

  async readRegister(): Promise<Buffer> {
    return Buffer.from([0x01, 0xf4]); // 500 in uint16
  }

  async writeControlWord(): Promise<VfdCommandResult> {
    return { success: true };
  }

  async writeSpeedReference(): Promise<VfdCommandResult> {
    return { success: true };
  }

  async writeRegister(): Promise<VfdCommandResult> {
    return { success: true };
  }

  validateConfiguration(): ValidationResult {
    return { valid: true, errors: [] };
  }

  getConfigurationSchema(): Record<string, unknown> {
    return { type: 'object' };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return { port: 502 };
  }

  // Expose protected methods for testing
  public testParseRawValue(
    buffer: Buffer,
    dataType: VfdDataType,
    byteOrder?: ByteOrder,
    wordOrder?: ByteOrder
  ): number {
    return this.parseRawValue(buffer, dataType, byteOrder, wordOrder);
  }

  public testApplyScaling(rawValue: number, scalingFactor?: number, offset?: number): number {
    return this.applyScaling(rawValue, scalingFactor, offset);
  }

  public testReverseScaling(
    engineeringValue: number,
    scalingFactor?: number,
    offset?: number
  ): number {
    return this.reverseScaling(engineeringValue, scalingFactor, offset);
  }

  public testParseStatusWord(value: number): ReturnType<BaseVfdAdapter['parseStatusWord']> {
    return this.parseStatusWord(value);
  }

  public testBuildControlWord(bits: Record<string, boolean>): number {
    return this.buildControlWord(bits);
  }

  public testGroupRegistersForBatchRead(
    mappings: VfdRegisterMapping[],
    maxGap?: number,
    maxBatchSize?: number
  ): ReturnType<BaseVfdAdapter['groupRegistersForBatchRead']> {
    return this.groupRegistersForBatchRead(mappings, maxGap, maxBatchSize);
  }

  public testExtractValueFromBuffer(
    buffer: Buffer,
    batchStartAddress: number,
    mapping: VfdRegisterMapping
  ): Buffer {
    return this.extractValueFromBuffer(buffer, batchStartAddress, mapping);
  }

  public testMapParameterName(parameterName: string): string | null {
    return this.mapParameterName(parameterName);
  }

  public testGenerateConnectionId(): string {
    return this.generateConnectionId();
  }

  public testCalculateCRC16(buffer: Buffer): number {
    return this.calculateCRC16(buffer);
  }
}

describe('BaseVfdAdapter', () => {
  let adapter: TestVfdAdapter;

  beforeEach(() => {
    adapter = new TestVfdAdapter();
  });

  describe('parseRawValue', () => {
    describe('UINT16', () => {
      it('should parse big endian uint16', () => {
        const buffer = Buffer.from([0x01, 0xf4]); // 500
        const result = adapter.testParseRawValue(buffer, VfdDataType.UINT16, ByteOrder.BIG);
        expect(result).toBe(500);
      });

      it('should parse little endian uint16', () => {
        const buffer = Buffer.from([0xf4, 0x01]); // 500 in LE
        const result = adapter.testParseRawValue(buffer, VfdDataType.UINT16, ByteOrder.LITTLE);
        expect(result).toBe(500);
      });
    });

    describe('INT16', () => {
      it('should parse positive int16', () => {
        const buffer = Buffer.from([0x01, 0xf4]); // 500
        const result = adapter.testParseRawValue(buffer, VfdDataType.INT16, ByteOrder.BIG);
        expect(result).toBe(500);
      });

      it('should parse negative int16', () => {
        const buffer = Buffer.from([0xff, 0x38]); // -200
        const result = adapter.testParseRawValue(buffer, VfdDataType.INT16, ByteOrder.BIG);
        expect(result).toBe(-200);
      });
    });

    describe('UINT32', () => {
      it('should parse big endian uint32 with big word order', () => {
        const buffer = Buffer.from([0x00, 0x01, 0x00, 0x00]); // 65536
        const result = adapter.testParseRawValue(
          buffer,
          VfdDataType.UINT32,
          ByteOrder.BIG,
          ByteOrder.BIG
        );
        expect(result).toBe(65536);
      });

      it('should parse uint32 with little word order', () => {
        const buffer = Buffer.from([0x00, 0x00, 0x00, 0x01]); // 65536 with swapped words
        const result = adapter.testParseRawValue(
          buffer,
          VfdDataType.UINT32,
          ByteOrder.BIG,
          ByteOrder.LITTLE
        );
        expect(result).toBe(65536);
      });

      it('should return 0 for short buffer', () => {
        const buffer = Buffer.from([0x00, 0x01]); // Only 2 bytes
        const result = adapter.testParseRawValue(buffer, VfdDataType.UINT32, ByteOrder.BIG);
        expect(result).toBe(0);
      });
    });

    describe('FLOAT32', () => {
      it('should parse big endian float32', () => {
        const buffer = Buffer.alloc(4);
        buffer.writeFloatBE(3.14159);
        const result = adapter.testParseRawValue(buffer, VfdDataType.FLOAT32, ByteOrder.BIG);
        expect(result).toBeCloseTo(3.14159, 4);
      });

      it('should parse little endian float32', () => {
        const buffer = Buffer.alloc(4);
        buffer.writeFloatLE(3.14159);
        const result = adapter.testParseRawValue(buffer, VfdDataType.FLOAT32, ByteOrder.LITTLE);
        expect(result).toBeCloseTo(3.14159, 4);
      });
    });

    describe('STATUS_WORD', () => {
      it('should parse status word as uint16', () => {
        const buffer = Buffer.from([0x02, 0x77]); // 0x0277
        const result = adapter.testParseRawValue(buffer, VfdDataType.STATUS_WORD, ByteOrder.BIG);
        expect(result).toBe(0x0277);
      });
    });
  });

  describe('applyScaling', () => {
    it('should apply scaling factor', () => {
      const result = adapter.testApplyScaling(500, 0.1);
      expect(result).toBe(50);
    });

    it('should apply offset', () => {
      const result = adapter.testApplyScaling(100, 1, 10);
      expect(result).toBe(110);
    });

    it('should apply both scaling and offset', () => {
      const result = adapter.testApplyScaling(500, 0.1, 5);
      expect(result).toBe(55);
    });

    it('should use defaults when not provided', () => {
      const result = adapter.testApplyScaling(100);
      expect(result).toBe(100);
    });
  });

  describe('reverseScaling', () => {
    it('should reverse scaling factor', () => {
      const result = adapter.testReverseScaling(50, 0.1);
      expect(result).toBe(500);
    });

    it('should reverse offset', () => {
      const result = adapter.testReverseScaling(110, 1, 10);
      expect(result).toBe(100);
    });

    it('should round to nearest integer', () => {
      const result = adapter.testReverseScaling(50.5, 0.1);
      expect(result).toBe(505);
    });
  });

  describe('parseStatusWord', () => {
    it('should parse running state', () => {
      const statusWord = 0x0877; // Running bit set
      const result = adapter.testParseStatusWord(statusWord);

      expect(result.ready).toBe(true);
      expect(result.running).toBe(true);
    });

    it('should parse fault state', () => {
      const statusWord = 0x0008; // Fault bit set
      const result = adapter.testParseStatusWord(statusWord);

      expect(result.fault).toBe(true);
    });

    it('should parse warning state', () => {
      const statusWord = 0x0080; // Warning bit set
      const result = adapter.testParseStatusWord(statusWord);

      expect(result.warning).toBe(true);
    });

    it('should parse direction', () => {
      const forwardStatus = 0x0000;
      const reverseStatus = 0x8000;

      expect(adapter.testParseStatusWord(forwardStatus).direction).toBe('forward');
      expect(adapter.testParseStatusWord(reverseStatus).direction).toBe('reverse');
    });

    it('should parse quick stop active', () => {
      const quickStopActive = 0x0000; // Bit 5 is 0 = quick stop active
      const quickStopInactive = 0x0020; // Bit 5 is 1 = normal operation

      expect(adapter.testParseStatusWord(quickStopActive).quickStopActive).toBe(true);
      expect(adapter.testParseStatusWord(quickStopInactive).quickStopActive).toBe(false);
    });
  });

  describe('buildControlWord', () => {
    it('should build control word for start', () => {
      const bits = {
        switchOn: true,
        enableVoltage: true,
        quickStop: true,
        enableOperation: true,
      };
      const result = adapter.testBuildControlWord(bits);

      expect(result & 0x0001).toBeTruthy(); // Switch on
      expect(result & 0x0002).toBeTruthy(); // Enable voltage
      expect(result & 0x0004).toBeTruthy(); // Quick stop
      expect(result & 0x0008).toBeTruthy(); // Enable operation
    });

    it('should build control word for fault reset', () => {
      const bits = { faultReset: true };
      const result = adapter.testBuildControlWord(bits);

      expect(result).toBe(0x0080);
    });

    it('should build control word for reverse', () => {
      const bits = { reverse: true };
      const result = adapter.testBuildControlWord(bits);

      expect(result).toBe(0x0800);
    });
  });

  describe('groupRegistersForBatchRead', () => {
    it('should return empty array for no mappings', () => {
      const result = adapter.testGroupRegistersForBatchRead([]);
      expect(result).toEqual([]);
    });

    it('should create single batch for consecutive registers', () => {
      const mappings: Partial<VfdRegisterMapping>[] = [
        { parameterName: 'reg1', registerAddress: 100, registerCount: 1, functionCode: 3 },
        { parameterName: 'reg2', registerAddress: 101, registerCount: 1, functionCode: 3 },
        { parameterName: 'reg3', registerAddress: 102, registerCount: 1, functionCode: 3 },
      ];

      const result = adapter.testGroupRegistersForBatchRead(mappings as VfdRegisterMapping[]);

      expect(result).toHaveLength(1);
      expect(result[0].startAddress).toBe(100);
      expect(result[0].count).toBe(3);
    });

    it('should create multiple batches for large gaps', () => {
      const mappings: Partial<VfdRegisterMapping>[] = [
        { parameterName: 'reg1', registerAddress: 100, registerCount: 1, functionCode: 3 },
        { parameterName: 'reg2', registerAddress: 200, registerCount: 1, functionCode: 3 },
      ];

      const result = adapter.testGroupRegistersForBatchRead(mappings as VfdRegisterMapping[], 10);

      expect(result).toHaveLength(2);
      expect(result[0].startAddress).toBe(100);
      expect(result[1].startAddress).toBe(200);
    });

    it('should separate batches by function code', () => {
      const mappings: Partial<VfdRegisterMapping>[] = [
        { parameterName: 'reg1', registerAddress: 100, registerCount: 1, functionCode: 3 },
        { parameterName: 'reg2', registerAddress: 101, registerCount: 1, functionCode: 4 },
      ];

      const result = adapter.testGroupRegistersForBatchRead(mappings as VfdRegisterMapping[]);

      expect(result).toHaveLength(2);
      expect(result[0].functionCode).toBe(3);
      expect(result[1].functionCode).toBe(4);
    });

    it('should respect max batch size', () => {
      const mappings: Partial<VfdRegisterMapping>[] = [
        { parameterName: 'reg1', registerAddress: 100, registerCount: 1, functionCode: 3 },
        { parameterName: 'reg2', registerAddress: 110, registerCount: 1, functionCode: 3 },
      ];

      const result = adapter.testGroupRegistersForBatchRead(
        mappings as VfdRegisterMapping[],
        20,
        5
      );

      expect(result).toHaveLength(2); // Separated due to max batch size
    });
  });

  describe('extractValueFromBuffer', () => {
    it('should extract value from correct offset', () => {
      const buffer = Buffer.from([0x00, 0x64, 0x00, 0xc8, 0x01, 0x2c]); // 100, 200, 300
      const mapping: Partial<VfdRegisterMapping> = {
        parameterName: 'test',
        registerAddress: 101,
        registerCount: 1,
      };

      const result = adapter.testExtractValueFromBuffer(
        buffer,
        100,
        mapping as VfdRegisterMapping
      );

      expect(result.readUInt16BE(0)).toBe(200);
    });

    it('should extract multi-register value', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x86, 0xa0]); // Large uint32
      const mapping: Partial<VfdRegisterMapping> = {
        parameterName: 'test',
        registerAddress: 101,
        registerCount: 2,
      };

      const result = adapter.testExtractValueFromBuffer(
        buffer,
        100,
        mapping as VfdRegisterMapping
      );

      expect(result.length).toBe(4);
    });

    it('should throw for out of bounds access', () => {
      const buffer = Buffer.from([0x00, 0x64]);
      const mapping: Partial<VfdRegisterMapping> = {
        parameterName: 'test',
        registerAddress: 102,
        registerCount: 1,
      };

      expect(() =>
        adapter.testExtractValueFromBuffer(buffer, 100, mapping as VfdRegisterMapping)
      ).toThrow();
    });
  });

  describe('mapParameterName', () => {
    it('should map output_frequency', () => {
      expect(adapter.testMapParameterName('output_frequency')).toBe('outputFrequency');
    });

    it('should map motor_current', () => {
      expect(adapter.testMapParameterName('motor_current')).toBe('motorCurrent');
    });

    it('should map running_hours variants', () => {
      expect(adapter.testMapParameterName('running_hours')).toBe('runningHours');
      expect(adapter.testMapParameterName('running_time')).toBe('runningHours');
      expect(adapter.testMapParameterName('run_time')).toBe('runningHours');
    });

    it('should map temperature variants', () => {
      expect(adapter.testMapParameterName('drive_temp')).toBe('driveTemperature');
      expect(adapter.testMapParameterName('heatsink_temp')).toBe('driveTemperature');
      expect(adapter.testMapParameterName('igbt_temp')).toBe('driveTemperature');
    });

    it('should return null for unknown parameter', () => {
      expect(adapter.testMapParameterName('unknown_param')).toBeNull();
    });
  });

  describe('generateConnectionId', () => {
    it('should generate unique IDs', () => {
      const id1 = adapter.testGenerateConnectionId();
      const id2 = adapter.testGenerateConnectionId();

      expect(id1).not.toBe(id2);
    });

    it('should include protocol code', () => {
      const id = adapter.testGenerateConnectionId();

      expect(id).toContain('modbus_tcp');
    });
  });

  describe('calculateCRC16', () => {
    it('should calculate correct CRC16 for Modbus', () => {
      // Known Modbus RTU message: Address 1, Function 3, Start 0, Count 10
      const buffer = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
      const crc = adapter.testCalculateCRC16(buffer);

      // Expected CRC for this message
      expect(crc).toBe(0xc5cd);
    });

    it('should calculate different CRC for different data', () => {
      const buffer1 = Buffer.from([0x01, 0x03, 0x00, 0x00]);
      const buffer2 = Buffer.from([0x01, 0x03, 0x00, 0x01]);

      const crc1 = adapter.testCalculateCRC16(buffer1);
      const crc2 = adapter.testCalculateCRC16(buffer2);

      expect(crc1).not.toBe(crc2);
    });
  });

  describe('connect and disconnect', () => {
    it('should create connection handle', async () => {
      const handle = await adapter.connect({});

      expect(handle.id).toBeDefined();
      expect(handle.protocol).toBe(VfdProtocol.MODBUS_TCP);
      expect(handle.isConnected).toBe(true);
    });

    it('should disconnect without error', async () => {
      const handle = await adapter.connect({});

      await expect(adapter.disconnect(handle)).resolves.not.toThrow();
    });
  });

  describe('testConnection', () => {
    it('should return success result', async () => {
      const result = await adapter.testConnection({});

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeDefined();
    });
  });

  describe('validateConfiguration', () => {
    it('should return valid result', () => {
      const result = adapter.validateConfiguration({});

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('getConfigurationSchema', () => {
    it('should return schema object', () => {
      const schema = adapter.getConfigurationSchema();

      expect(schema).toBeDefined();
      expect(typeof schema).toBe('object');
    });
  });

  describe('getDefaultConfiguration', () => {
    it('should return default config', () => {
      const config = adapter.getDefaultConfiguration();

      expect(config).toBeDefined();
      expect(config.port).toBe(502);
    });
  });
});
