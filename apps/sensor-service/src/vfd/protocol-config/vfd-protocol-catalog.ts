import { ProtocolImplementationStatus } from '../../protocol/adapters/protocol-implementation-status';
import { VfdProtocol } from '../entities/vfd.enums';

/**
 * VFD protocol configuration catalog — the single source of truth (SSoT) for
 * per-protocol classification, configuration JSON schema, defaults and
 * validation.
 *
 * Re-homed from the retired in-process `vfd/adapters` module (SENSOR-CRITICAL-007
 * / SENSOR-CRITICAL-009, Faz 2C/3). Those adapters mixed pure config metadata with
 * fake I/O that reported success without ever reaching a drive. The config half is
 * legitimate and lives here as pure, side-effect-free data + validators; the I/O
 * half is deleted, because all VFD I/O is edge-delegated (edge `read_modbus` /
 * `write_modbus`).
 *
 * Edge reachability, not cloud sockets, decides which protocols are real. The edge
 * gateway speaks Modbus, so only `MODBUS_TCP` / `MODBUS_RTU` are `EDGE_DELEGATED`
 * (a drive is reached through its owning edge). Every other protocol is
 * `UNSUPPORTED`: it has no edge-serviceable path, so it is hidden from selection
 * and rejected at validation rather than sold as a fake capability
 * (SENSOR-CRITICAL-009). The catalog is an exhaustive `Record<VfdProtocol, …>`, so
 * adding an enum member without a classification is a compile-time error.
 */

/** Result of validating a protocol configuration payload. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Physical connection medium, used for grouping/iconography on the client. */
export type VfdProtocolConnectionType = 'serial' | 'ethernet' | 'fieldbus';

/** Public, client-facing description of a selectable VFD protocol. */
export interface VfdProtocolInfo {
  code: VfdProtocol;
  name: string;
  description: string;
  connectionType: VfdProtocolConnectionType;
  implementationStatus: ProtocolImplementationStatus;
  configurationSchema: Record<string, unknown>;
  defaultConfiguration: Record<string, unknown>;
}

/**
 * One catalog entry. `schema`/`defaults` are non-null ONLY for edge-serviceable
 * protocols; `UNSUPPORTED` protocols carry `null` (there is nothing to configure)
 * and a `validate` that always fails with an honest reason.
 */
interface VfdProtocolConfigDefinition {
  name: string;
  description: string;
  connectionType: VfdProtocolConnectionType;
  implementationStatus: ProtocolImplementationStatus;
  schema: Record<string, unknown> | null;
  defaults: Record<string, unknown> | null;
  validate(config: unknown): ValidationResult;
}

// ============ Modbus TCP (edge-delegated) ============

function validateModbusTcp(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Configuration must be an object'] };
  }

  const cfg = config as Record<string, unknown>;

  if (!cfg['host'] || typeof cfg['host'] !== 'string') {
    errors.push('host is required and must be a string');
  } else {
    const ipRegex =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
    if (
      !ipRegex.test(cfg['host']) &&
      !hostnameRegex.test(cfg['host']) &&
      cfg['host'] !== 'localhost'
    ) {
      errors.push('host must be a valid IP address or hostname');
    }
  }

  if (cfg['port'] !== undefined) {
    if (typeof cfg['port'] !== 'number' || cfg['port'] < 1 || cfg['port'] > 65535) {
      errors.push('port must be between 1 and 65535');
    }
  }

  if (cfg['unitId'] !== undefined) {
    if (typeof cfg['unitId'] !== 'number' || cfg['unitId'] < 0 || cfg['unitId'] > 255) {
      errors.push('unitId must be between 0 and 255');
    }
  }

  if (cfg['connectionTimeout'] !== undefined) {
    if (
      typeof cfg['connectionTimeout'] !== 'number' ||
      cfg['connectionTimeout'] < 100 ||
      cfg['connectionTimeout'] > 60000
    ) {
      errors.push('connectionTimeout must be between 100 and 60000 ms');
    }
  }

  if (cfg['responseTimeout'] !== undefined) {
    if (
      typeof cfg['responseTimeout'] !== 'number' ||
      cfg['responseTimeout'] < 100 ||
      cfg['responseTimeout'] > 30000
    ) {
      errors.push('responseTimeout must be between 100 and 30000 ms');
    }
  }

  return { valid: errors.length === 0, errors };
}

const MODBUS_TCP_SCHEMA: Record<string, unknown> = {
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

const MODBUS_TCP_DEFAULTS: Record<string, unknown> = {
  host: '',
  port: 502,
  unitId: 1,
  connectionTimeout: 5000,
  responseTimeout: 1000,
  keepAlive: true,
  reconnectInterval: 5000,
};

// ============ Modbus RTU (edge-delegated) ============

const MODBUS_RTU_BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200];

function validateModbusRtu(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Configuration must be an object'] };
  }

  const cfg = config as Record<string, unknown>;

  if (!cfg['serialPort'] || typeof cfg['serialPort'] !== 'string') {
    errors.push('serialPort is required and must be a string');
  }

  if (cfg['slaveId'] === undefined || typeof cfg['slaveId'] !== 'number') {
    errors.push('slaveId is required and must be a number');
  } else if (cfg['slaveId'] < 1 || cfg['slaveId'] > 247) {
    errors.push('slaveId must be between 1 and 247');
  }

  if (cfg['baudRate'] !== undefined && !MODBUS_RTU_BAUD_RATES.includes(cfg['baudRate'] as number)) {
    errors.push(`baudRate must be one of: ${MODBUS_RTU_BAUD_RATES.join(', ')}`);
  }

  if (cfg['dataBits'] !== undefined && ![7, 8].includes(cfg['dataBits'] as number)) {
    errors.push('dataBits must be 7 or 8');
  }

  if (cfg['parity'] !== undefined && !['none', 'even', 'odd'].includes(cfg['parity'] as string)) {
    errors.push('parity must be "none", "even", or "odd"');
  }

  if (cfg['stopBits'] !== undefined && ![1, 2].includes(cfg['stopBits'] as number)) {
    errors.push('stopBits must be 1 or 2');
  }

  if (cfg['timeout'] !== undefined) {
    if (typeof cfg['timeout'] !== 'number' || cfg['timeout'] < 100 || cfg['timeout'] > 30000) {
      errors.push('timeout must be between 100 and 30000 ms');
    }
  }

  return { valid: errors.length === 0, errors };
}

const MODBUS_RTU_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['serialPort', 'slaveId'],
  properties: {
    serialPort: {
      type: 'string',
      title: 'Serial Port',
      description: 'Serial port path (e.g., COM3 or /dev/ttyUSB0)',
      examples: ['COM3', '/dev/ttyUSB0', '/dev/ttyS0'],
    },
    slaveId: {
      type: 'integer',
      title: 'Slave ID',
      description: 'Modbus slave address (1-247)',
      minimum: 1,
      maximum: 247,
      default: 1,
    },
    baudRate: {
      type: 'integer',
      title: 'Baud Rate',
      enum: MODBUS_RTU_BAUD_RATES,
      default: 9600,
    },
    dataBits: {
      type: 'integer',
      title: 'Data Bits',
      enum: [7, 8],
      default: 8,
    },
    parity: {
      type: 'string',
      title: 'Parity',
      enum: ['none', 'even', 'odd'],
      default: 'none',
    },
    stopBits: {
      type: 'integer',
      title: 'Stop Bits',
      enum: [1, 2],
      default: 1,
    },
    timeout: {
      type: 'integer',
      title: 'Timeout (ms)',
      description: 'Response timeout in milliseconds',
      minimum: 100,
      maximum: 30000,
      default: 1000,
    },
    retryCount: {
      type: 'integer',
      title: 'Retry Count',
      description: 'Number of retries on failure',
      minimum: 0,
      maximum: 10,
      default: 3,
    },
  },
};

const MODBUS_RTU_DEFAULTS: Record<string, unknown> = {
  serialPort: '',
  slaveId: 1,
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};

/**
 * Build an `UNSUPPORTED` catalog entry: no configurable schema, and a `validate`
 * that always fails honestly. A tenant cannot register or test a protocol the
 * edge cannot service (SENSOR-CRITICAL-009).
 */
function unsupportedProtocol(
  name: string,
  description: string,
  connectionType: VfdProtocolConnectionType,
): VfdProtocolConfigDefinition {
  return {
    name,
    description,
    connectionType,
    implementationStatus: ProtocolImplementationStatus.UNSUPPORTED,
    schema: null,
    defaults: null,
    validate: (): ValidationResult => ({
      valid: false,
      errors: [
        `${name} is not supported: no edge-serviceable implementation exists for this protocol. ` +
          `Connect the drive over Modbus TCP or Modbus RTU via an edge gateway.`,
      ],
    }),
  };
}

/**
 * The exhaustive protocol catalog. TypeScript forces an entry for every
 * `VfdProtocol` member, so a new protocol cannot be added without an explicit
 * classification (compile-time completeness — no silent inheritance of a Modbus
 * default, unlike the old adapter switch).
 */
const VFD_PROTOCOL_CATALOG: Record<VfdProtocol, VfdProtocolConfigDefinition> = {
  [VfdProtocol.MODBUS_TCP]: {
    name: 'Modbus TCP',
    description: 'Ethernet communication using Modbus TCP/IP protocol',
    connectionType: 'ethernet',
    implementationStatus: ProtocolImplementationStatus.EDGE_DELEGATED,
    schema: MODBUS_TCP_SCHEMA,
    defaults: MODBUS_TCP_DEFAULTS,
    validate: validateModbusTcp,
  },
  [VfdProtocol.MODBUS_RTU]: {
    name: 'Modbus RTU',
    description: 'Serial communication using Modbus RTU protocol',
    connectionType: 'serial',
    implementationStatus: ProtocolImplementationStatus.EDGE_DELEGATED,
    schema: MODBUS_RTU_SCHEMA,
    defaults: MODBUS_RTU_DEFAULTS,
    validate: validateModbusRtu,
  },
  [VfdProtocol.PROFIBUS_DP]: unsupportedProtocol(
    'PROFIBUS DP',
    'Fieldbus communication using PROFIBUS DP protocol',
    'fieldbus',
  ),
  [VfdProtocol.PROFINET]: unsupportedProtocol(
    'PROFINET IO',
    'Industrial Ethernet using PROFINET IO protocol',
    'ethernet',
  ),
  [VfdProtocol.ETHERNET_IP]: unsupportedProtocol(
    'EtherNet/IP',
    'Industrial Ethernet using CIP over EtherNet/IP',
    'ethernet',
  ),
  [VfdProtocol.CANOPEN]: unsupportedProtocol(
    'CANopen',
    'CAN-based communication using CANopen (CiA 402)',
    'fieldbus',
  ),
  [VfdProtocol.BACNET_IP]: unsupportedProtocol(
    'BACnet/IP',
    'Building automation using BACnet over IP',
    'ethernet',
  ),
  [VfdProtocol.BACNET_MSTP]: unsupportedProtocol(
    'BACnet MS/TP',
    'Building automation using BACnet over RS-485',
    'serial',
  ),
};

function getDefinition(protocol: VfdProtocol): VfdProtocolConfigDefinition | undefined {
  return VFD_PROTOCOL_CATALOG[protocol];
}

/**
 * Classify a protocol. Unknown values fail safe to `UNSUPPORTED` so an unmapped
 * protocol can never be treated as reachable.
 */
export function getVfdProtocolImplementationStatus(
  protocol: VfdProtocol,
): ProtocolImplementationStatus {
  return getDefinition(protocol)?.implementationStatus ?? ProtocolImplementationStatus.UNSUPPORTED;
}

/** A protocol is selectable (offered in the UI) iff it is not `UNSUPPORTED`. */
export function isSelectableVfdProtocol(protocol: VfdProtocol): boolean {
  return getVfdProtocolImplementationStatus(protocol) !== ProtocolImplementationStatus.UNSUPPORTED;
}

/** Configuration JSON schema for a protocol, or `null` when unsupported. */
export function getVfdProtocolSchema(protocol: VfdProtocol): Record<string, unknown> | null {
  return getDefinition(protocol)?.schema ?? null;
}

/** Default configuration for a protocol, or `null` when unsupported. */
export function getVfdProtocolDefaults(protocol: VfdProtocol): Record<string, unknown> | null {
  return getDefinition(protocol)?.defaults ?? null;
}

/** Validate a configuration payload against its protocol's rules. */
export function validateVfdProtocolConfig(
  protocol: VfdProtocol,
  config: unknown,
): ValidationResult {
  const definition = getDefinition(protocol);
  if (!definition) {
    return { valid: false, errors: [`Unknown VFD protocol: ${String(protocol)}`] };
  }
  return definition.validate(config);
}

/**
 * The selectable protocols with their client-facing metadata + schema. Only
 * edge-serviceable protocols appear; `UNSUPPORTED` protocols are omitted so the
 * UI never offers a drive path that cannot be honoured.
 */
export function getSelectableVfdProtocolInfo(): VfdProtocolInfo[] {
  const info: VfdProtocolInfo[] = [];
  for (const code of Object.values(VfdProtocol)) {
    const definition = VFD_PROTOCOL_CATALOG[code];
    if (definition.implementationStatus === ProtocolImplementationStatus.UNSUPPORTED) {
      continue;
    }
    info.push({
      code,
      name: definition.name,
      description: definition.description,
      connectionType: definition.connectionType,
      implementationStatus: definition.implementationStatus,
      configurationSchema: definition.schema ?? {},
      defaultConfiguration: definition.defaults ?? {},
    });
  }
  return info;
}
