/**
 * Type definitions for nodes7 library (Siemens S7 protocol)
 * @see https://github.com/plcpeople/nodes7
 */

/**
 * S7 Client interface
 */
export interface S7Client {
  /** Connect to PLC */
  connect(options: S7ConnectionOptions, callback: (error?: Error) => void): void;

  /** Connect to PLC (Promise wrapper) */
  connectAsync(options: S7ConnectionOptions): Promise<void>;

  /** Disconnect from PLC */
  disconnect(callback?: () => void): void;

  /** Check if connected */
  isConnected(): boolean;

  /** Add items to read list */
  addItems(items: string | string[]): void;

  /** Remove items from read list */
  removeItems(items?: string | string[]): void;

  /** Read all added items */
  readAllItems(callback: (error: Error | null, values: S7ReadResult) => void): void;

  /** Read all added items (Promise wrapper) */
  readAllItemsAsync(): Promise<S7ReadResult>;

  /** Write items */
  writeItems(items: string | string[], values: S7Value | S7Value[], callback: (error?: Error) => void): void;

  /** Write items (Promise wrapper) */
  writeItemsAsync(items: string | string[], values: S7Value | S7Value[]): Promise<void>;

  /** Set connection parameters */
  initiateConnection(options: S7ConnectionOptions, callback: (error?: Error) => void): void;

  /** Set translation callback */
  setTranslationCB(callback: (tag: string) => string): void;

  /** Get connection status */
  connectionState: S7ConnectionState;
}

/**
 * Connection options
 */
export interface S7ConnectionOptions {
  /** PLC IP address */
  host: string;
  /** PLC port (default: 102) */
  port?: number;
  /** Rack number (default: 0) */
  rack?: number;
  /** Slot number (default: 1 for S7-300/400, 0 for S7-1200/1500) */
  slot?: number;
  /** Connection timeout in ms */
  timeout?: number;
  /** Connection type */
  connectionType?: S7ConnectionType;
  /** Local TSAP */
  localTSAP?: number;
  /** Remote TSAP */
  remoteTSAP?: number;
}

export enum S7ConnectionType {
  PG = 1,      // Programming device
  OP = 2,      // Operator panel
  Basic = 3,   // Basic communication
}

/**
 * Connection state
 */
export enum S7ConnectionState {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
  Error = 3,
}

/**
 * Read result - map of item names to values
 */
export interface S7ReadResult {
  [itemName: string]: S7Value;
}

/**
 * S7 value types
 */
export type S7Value = number | boolean | string | Buffer | number[] | boolean[];

/**
 * S7 address format
 * Format: DB<num>,<type><offset>[.<bit>]
 * Examples:
 *   DB1,INT0     - Integer at byte 0 of DB1
 *   DB1,REAL4    - Real at byte 4 of DB1
 *   M0.0         - Merker bit 0.0
 *   I0.0         - Input bit 0.0
 *   Q0.0         - Output bit 0.0
 */
export interface S7Address {
  /** Area type */
  area: S7Area;
  /** Data block number (for DB area) */
  dbNumber?: number;
  /** Data type */
  dataType: S7DataType;
  /** Byte offset */
  offset: number;
  /** Bit offset (for BOOL type) */
  bitOffset?: number;
  /** Array length */
  arrayLength?: number;
}

export enum S7Area {
  /** Process inputs */
  PE = 'I',
  /** Process outputs */
  PA = 'Q',
  /** Merker (flags) */
  MK = 'M',
  /** Data blocks */
  DB = 'DB',
  /** Counter */
  CT = 'C',
  /** Timer */
  TM = 'T',
}

export enum S7DataType {
  /** Boolean (1 bit) */
  BOOL = 'X',
  /** Byte (8 bits) */
  BYTE = 'B',
  /** Char (8 bits) */
  CHAR = 'C',
  /** Integer (16 bits) */
  INT = 'INT',
  /** Word (16 bits unsigned) */
  WORD = 'W',
  /** Double integer (32 bits) */
  DINT = 'DINT',
  /** Double word (32 bits unsigned) */
  DWORD = 'DW',
  /** Real (32 bits float) */
  REAL = 'REAL',
  /** String */
  STRING = 'S',
  /** Date and time */
  DATETIME = 'DT',
}

/**
 * Parse S7 address string to structured format
 */
export function parseS7Address(address: string): S7Address | null {
  // DB address: DB<num>,<type><offset>[.<bit>]
  const dbMatch = address.match(/^DB(\d+),(\w+)(\d+)(?:\.(\d))?$/i);
  if (dbMatch) {
    const [, dbNum, dataType, offset, bit] = dbMatch;
    if (!dbNum || !dataType || !offset) return null;
    return {
      area: S7Area.DB,
      dbNumber: parseInt(dbNum, 10),
      dataType: mapDataType(dataType),
      offset: parseInt(offset, 10),
      bitOffset: bit ? parseInt(bit, 10) : undefined,
    };
  }

  // Memory area address: <area><offset>.<bit> or <area><type><offset>
  const memMatch = address.match(/^([IQMC])(\w*)(\d+)(?:\.(\d))?$/i);
  if (memMatch) {
    const [, area, dataType, offset, bit] = memMatch;
    if (!area || !offset) return null;
    return {
      area: mapArea(area),
      dataType: dataType ? mapDataType(dataType) : S7DataType.BOOL,
      offset: parseInt(offset, 10),
      bitOffset: bit ? parseInt(bit, 10) : undefined,
    };
  }

  return null;
}

function mapArea(area: string): S7Area {
  switch (area.toUpperCase()) {
    case 'I': return S7Area.PE;
    case 'Q': return S7Area.PA;
    case 'M': return S7Area.MK;
    case 'C': return S7Area.CT;
    default: return S7Area.MK;
  }
}

function mapDataType(type: string): S7DataType {
  switch (type.toUpperCase()) {
    case 'X': case 'BOOL': return S7DataType.BOOL;
    case 'B': case 'BYTE': return S7DataType.BYTE;
    case 'C': case 'CHAR': return S7DataType.CHAR;
    case 'INT': return S7DataType.INT;
    case 'W': case 'WORD': return S7DataType.WORD;
    case 'DINT': return S7DataType.DINT;
    case 'DW': case 'DWORD': return S7DataType.DWORD;
    case 'REAL': return S7DataType.REAL;
    case 'S': case 'STRING': return S7DataType.STRING;
    case 'DT': case 'DATETIME': return S7DataType.DATETIME;
    default: return S7DataType.INT;
  }
}

/**
 * Build S7 address string from structured format
 */
export function buildS7Address(addr: S7Address): string {
  if (addr.area === S7Area.DB) {
    const base = `DB${addr.dbNumber},${addr.dataType}${addr.offset}`;
    return addr.bitOffset !== undefined ? `${base}.${addr.bitOffset}` : base;
  }

  const base = `${addr.area}${addr.dataType}${addr.offset}`;
  return addr.bitOffset !== undefined ? `${base}.${addr.bitOffset}` : base;
}

/**
 * Helper to create an S7 client from dynamic import
 */
export async function createS7Client(): Promise<S7Client> {
  const nodes7 = await import('nodes7');
  const client = new nodes7.default() as unknown as S7Client;

  // Add promise wrappers
  client.connectAsync = (options: S7ConnectionOptions): Promise<void> => {
    return new Promise((resolve, reject) => {
      client.connect(options, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  client.readAllItemsAsync = (): Promise<S7ReadResult> => {
    return new Promise((resolve, reject) => {
      client.readAllItems((error, values) => {
        if (error) reject(error);
        else resolve(values);
      });
    });
  };

  client.writeItemsAsync = (items: string | string[], values: S7Value | S7Value[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      client.writeItems(items, values, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  return client;
}
