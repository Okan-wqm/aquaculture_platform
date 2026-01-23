/**
 * Type definitions for modbus-serial library
 * @see https://github.com/yaacov/node-modbus-serial
 */

/**
 * Modbus RTU client interface
 */
export interface ModbusRTUClient {
  /** Connect via TCP */
  connectTCP(ip: string, options?: ModbusTcpOptions): Promise<void>;

  /** Connect via RTU (serial) */
  connectRTU(path: string, options?: ModbusSerialOptions): Promise<void>;

  /** Connect via RTU over TCP (buffered) */
  connectRTUBuffered(ip: string, options?: ModbusTcpOptions): Promise<void>;

  /** Connect via ASCII */
  connectAsciiSerial(path: string, options?: ModbusSerialOptions): Promise<void>;

  /** Set the Modbus unit ID (slave address) */
  setID(id: number): void;

  /** Set timeout in milliseconds */
  setTimeout(timeout: number): void;

  /** Check if connected */
  isOpen: boolean;

  /** Close connection */
  close(callback?: () => void): void;

  /** Read coils (FC 01) */
  readCoils(address: number, length: number): Promise<ModbusReadResult>;

  /** Read discrete inputs (FC 02) */
  readDiscreteInputs(address: number, length: number): Promise<ModbusReadResult>;

  /** Read holding registers (FC 03) */
  readHoldingRegisters(address: number, length: number): Promise<ModbusReadResult>;

  /** Read input registers (FC 04) */
  readInputRegisters(address: number, length: number): Promise<ModbusReadResult>;

  /** Write single coil (FC 05) */
  writeCoil(address: number, state: boolean): Promise<void>;

  /** Write single register (FC 06) */
  writeRegister(address: number, value: number): Promise<void>;

  /** Write multiple coils (FC 15) */
  writeCoils(address: number, states: boolean[]): Promise<void>;

  /** Write multiple registers (FC 16) */
  writeRegisters(address: number, values: number[]): Promise<void>;
}

/**
 * TCP connection options
 */
export interface ModbusTcpOptions {
  port?: number;
  timeout?: number;
}

/**
 * Serial connection options
 */
export interface ModbusSerialOptions {
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

/**
 * Read result from Modbus operations
 */
export interface ModbusReadResult {
  /** Raw data buffer */
  buffer: Buffer;
  /** Array of values (registers or coils) */
  data: number[] | boolean[];
}

/**
 * Factory function type for creating Modbus client
 */
export type ModbusRTUClientFactory = new () => ModbusRTUClient;

/**
 * Helper to create a typed Modbus client from dynamic import
 */
export async function createModbusClient(): Promise<ModbusRTUClient> {
  const ModbusRTU = (await import('modbus-serial')).default as ModbusRTUClientFactory;
  return new ModbusRTU();
}

/**
 * Parse Modbus register data based on data type
 */
export function parseModbusValue(
  buffer: Buffer,
  dataType: ModbusDataType,
  byteOrder: 'BE' | 'LE' = 'BE',
): number {
  switch (dataType) {
    case 'int16':
      return byteOrder === 'BE' ? buffer.readInt16BE(0) : buffer.readInt16LE(0);
    case 'uint16':
      return byteOrder === 'BE' ? buffer.readUInt16BE(0) : buffer.readUInt16LE(0);
    case 'int32':
      return byteOrder === 'BE' ? buffer.readInt32BE(0) : buffer.readInt32LE(0);
    case 'uint32':
      return byteOrder === 'BE' ? buffer.readUInt32BE(0) : buffer.readUInt32LE(0);
    case 'float32':
      return byteOrder === 'BE' ? buffer.readFloatBE(0) : buffer.readFloatLE(0);
    case 'float64':
      return byteOrder === 'BE' ? buffer.readDoubleBE(0) : buffer.readDoubleLE(0);
    default:
      return buffer.readUInt16BE(0);
  }
}

export type ModbusDataType = 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64' | 'boolean';
