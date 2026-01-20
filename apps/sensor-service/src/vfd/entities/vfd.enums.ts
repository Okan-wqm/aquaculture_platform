/**
 * VFD (Variable Frequency Drive) Enums
 * Supports 8 major brands and 7+ industrial protocols
 */

export enum VfdBrand {
  DANFOSS = 'danfoss',
  ABB = 'abb',
  SIEMENS = 'siemens',
  SCHNEIDER = 'schneider',
  YASKAWA = 'yaskawa',
  DELTA = 'delta',
  MITSUBISHI = 'mitsubishi',
  ROCKWELL = 'rockwell',
}

export enum VfdProtocol {
  MODBUS_RTU = 'modbus_rtu',
  MODBUS_TCP = 'modbus_tcp',
  PROFIBUS_DP = 'profibus_dp',
  PROFINET = 'profinet',
  ETHERNET_IP = 'ethernet_ip',
  CANOPEN = 'canopen',
  BACNET_IP = 'bacnet_ip',
  BACNET_MSTP = 'bacnet_mstp',
}

export enum VfdParameterCategory {
  STATUS = 'status',
  MOTOR = 'motor',
  ENERGY = 'energy',
  THERMAL = 'thermal',
  FAULT = 'fault',
  CONTROL = 'control',
}

export enum VfdDeviceStatus {
  DRAFT = 'draft',
  PENDING_TEST = 'pending_test',
  TESTING = 'testing',
  TEST_FAILED = 'test_failed',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  OFFLINE = 'offline',
}

export enum VfdCommandType {
  START = 'start',
  STOP = 'stop',
  REVERSE = 'reverse',
  SET_FREQUENCY = 'set_frequency',
  SET_SPEED = 'set_speed',
  FAULT_RESET = 'fault_reset',
  QUICK_STOP = 'quick_stop',
  EMERGENCY_STOP = 'emergency_stop',
  JOG_FORWARD = 'jog_forward',
  JOG_REVERSE = 'jog_reverse',
}

export enum VfdDataType {
  UINT16 = 'uint16',
  INT16 = 'int16',
  UINT32 = 'uint32',
  INT32 = 'int32',
  FLOAT32 = 'float32',
  CONTROL_WORD = 'control_word',
  STATUS_WORD = 'status_word',
}

export enum ByteOrder {
  BIG = 'big',
  LITTLE = 'little',
}

// Brand display names
export const VFD_BRAND_NAMES: Record<VfdBrand, string> = {
  [VfdBrand.DANFOSS]: 'Danfoss',
  [VfdBrand.ABB]: 'ABB',
  [VfdBrand.SIEMENS]: 'Siemens',
  [VfdBrand.SCHNEIDER]: 'Schneider Electric',
  [VfdBrand.YASKAWA]: 'Yaskawa',
  [VfdBrand.DELTA]: 'Delta Electronics',
  [VfdBrand.MITSUBISHI]: 'Mitsubishi Electric',
  [VfdBrand.ROCKWELL]: 'Rockwell Automation',
};

// Protocol display names
export const VFD_PROTOCOL_NAMES: Record<VfdProtocol, string> = {
  [VfdProtocol.MODBUS_RTU]: 'Modbus RTU',
  [VfdProtocol.MODBUS_TCP]: 'Modbus TCP',
  [VfdProtocol.PROFIBUS_DP]: 'Profibus DP',
  [VfdProtocol.PROFINET]: 'Profinet',
  [VfdProtocol.ETHERNET_IP]: 'EtherNet/IP',
  [VfdProtocol.CANOPEN]: 'CANopen',
  [VfdProtocol.BACNET_IP]: 'BACnet/IP',
  [VfdProtocol.BACNET_MSTP]: 'BACnet MS/TP',
};

// Brand supported protocols
export const VFD_BRAND_PROTOCOLS: Record<VfdBrand, VfdProtocol[]> = {
  [VfdBrand.DANFOSS]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.ABB]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.SIEMENS]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.CANOPEN,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.SCHNEIDER]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.YASKAWA]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
  ],
  [VfdBrand.DELTA]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.CANOPEN,
  ],
  [VfdBrand.MITSUBISHI]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.ROCKWELL]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
  ],
};

// Brand model series
export const VFD_BRAND_MODELS: Record<VfdBrand, string[]> = {
  [VfdBrand.DANFOSS]: ['FC102', 'FC302', 'FC51', 'VLT 2800', 'VLT 5000', 'VLT 6000', 'VLT HVAC'],
  [VfdBrand.ABB]: ['ACS580', 'ACS880', 'ACS355', 'ACS310', 'ACS550', 'ACS800', 'ACS1000'],
  [VfdBrand.SIEMENS]: ['G120', 'G120C', 'G120D', 'G120P', 'G130', 'S120', 'MICROMASTER 440'],
  [VfdBrand.SCHNEIDER]: ['Altivar 12', 'Altivar 312', 'Altivar 320', 'Altivar 340', 'Altivar 600', 'Altivar 900', 'Altivar Process'],
  [VfdBrand.YASKAWA]: ['A1000', 'V1000', 'J1000', 'GA500', 'GA700', 'U1000', 'Z1000'],
  [VfdBrand.DELTA]: ['VFD-E', 'VFD-EL', 'VFD-C', 'VFD-CP', 'VFD-M', 'VFD-MS300', 'VFD-C2000'],
  [VfdBrand.MITSUBISHI]: ['FR-A800', 'FR-E800', 'FR-F800', 'FR-D700', 'FR-A700', 'FR-E700'],
  [VfdBrand.ROCKWELL]: ['PowerFlex 523', 'PowerFlex 525', 'PowerFlex 527', 'PowerFlex 700', 'PowerFlex 753', 'PowerFlex 755'],
};

// Default serial configurations per brand
export interface SerialConfig {
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
}

export const VFD_BRAND_DEFAULT_SERIAL: Record<VfdBrand, SerialConfig> = {
  [VfdBrand.DANFOSS]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.ABB]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.SIEMENS]: { baudRate: 19200, dataBits: 8, parity: 'even', stopBits: 1 },
  [VfdBrand.SCHNEIDER]: { baudRate: 19200, dataBits: 8, parity: 'even', stopBits: 1 },
  [VfdBrand.YASKAWA]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.DELTA]: { baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 },
  [VfdBrand.MITSUBISHI]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.ROCKWELL]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
};

// Standard control word commands (CiA402 / PROFIdrive compatible)
export const VFD_CONTROL_COMMANDS = {
  SHUTDOWN: 0x0006,
  SWITCH_ON: 0x0007,
  ENABLE_OPERATION: 0x000f,
  DISABLE_VOLTAGE: 0x0000,
  QUICK_STOP: 0x0002,
  DISABLE_OPERATION: 0x0007,
  FAULT_RESET: 0x0080,
  RUN_FORWARD: 0x000f,
  RUN_REVERSE: 0x080f,
  // Danfoss FC Protocol specific
  DANFOSS_START: 0x047f,
  DANFOSS_STOP: 0x043c,
};

// Standard status word bits
export const VFD_STATUS_BITS = {
  READY_TO_SWITCH_ON: 0,
  SWITCHED_ON: 1,
  OPERATION_ENABLED: 2,
  FAULT: 3,
  VOLTAGE_ENABLED: 4,
  QUICK_STOP: 5,
  SWITCH_ON_DISABLED: 6,
  WARNING: 7,
  AT_SETPOINT: 8,
  REMOTE: 9,
  TARGET_REACHED: 10,
  INTERNAL_LIMIT: 11,
};
