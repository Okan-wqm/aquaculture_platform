/**
 * VFD (Variable Frequency Drive) Enums
 * Supports 8 major brands and 7+ industrial protocols
 */

import { registerEnumType } from '@nestjs/graphql';

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
  CONFIGURATION = 'configuration',
}

export enum VfdParameterGroup {
  RAMP_TIMES = 'ramp_times',
  FREQUENCY_LIMITS = 'frequency_limits',
  MOTOR_NAMEPLATE = 'motor_nameplate',
  CURRENT_LIMITS = 'current_limits',
  VF_CONTROL = 'vf_control',
  PID_CONTROLLER = 'pid_controller',
  DIGITAL_IO = 'digital_io',
  COMMUNICATION = 'communication',
  PROTECTION = 'protection',
  JOG = 'jog',
  ADVANCED = 'advanced',
}

export enum VfdChangeSetStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  APPLYING = 'applying',
  APPLIED = 'applied',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
  // CANCELLED — maker (or admin) aborts a change set before it is applied to the
  // device. Reachable from DRAFT (abandon a never-submitted draft) and from
  // APPROVED (call off a scheduled/not-yet-applied change). Distinct from
  // REJECTED, which is the checker's verdict during PENDING_APPROVAL. The
  // backing column is varchar(30) (see Baseline migration vfd_change_sets), so
  // this new value needs no DB migration — Postgres accepts the string as-is.
  CANCELLED = 'cancelled',
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum VfdChangeSetItemStatus {
  PENDING = 'pending',
  APPLIED = 'applied',
  VERIFIED = 'verified',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

export enum VfdAuditAction {
  APPLY = 'apply',
  ROLLBACK = 'rollback',
  AUTO_APPLY = 'auto_apply',
  EMERGENCY_OVERRIDE = 'emergency_override',
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
  COAST_STOP = 'coast_stop',
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
  [VfdBrand.SIEMENS]: { baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 },
  [VfdBrand.SCHNEIDER]: { baudRate: 19200, dataBits: 8, parity: 'even', stopBits: 1 },
  [VfdBrand.YASKAWA]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 2 },
  [VfdBrand.DELTA]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.MITSUBISHI]: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  [VfdBrand.ROCKWELL]: { baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 },
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

// Register enums with GraphQL
registerEnumType(VfdBrand, {
  name: 'VfdBrand',
  description: 'VFD manufacturer brands',
});

registerEnumType(VfdProtocol, {
  name: 'VfdProtocol',
  description: 'VFD communication protocols',
});

registerEnumType(VfdParameterCategory, {
  name: 'VfdParameterCategory',
  description: 'VFD parameter categories',
});

registerEnumType(VfdDeviceStatus, {
  name: 'VfdDeviceStatus',
  description: 'VFD device status',
});

registerEnumType(VfdCommandType, {
  name: 'VfdCommandType',
  description: 'VFD command types',
});

registerEnumType(VfdDataType, {
  name: 'VfdDataType',
  description: 'VFD data types for register mapping',
});

registerEnumType(ByteOrder, {
  name: 'ByteOrder',
  description: 'Byte order for data parsing',
});

registerEnumType(VfdParameterGroup, {
  name: 'VfdParameterGroup',
  description: 'VFD configuration parameter groups',
});

registerEnumType(VfdChangeSetStatus, {
  name: 'VfdChangeSetStatus',
  description: 'VFD change set workflow status',
});

registerEnumType(RiskLevel, {
  name: 'RiskLevel',
  description: 'Risk level for VFD parameter changes',
});

registerEnumType(VfdChangeSetItemStatus, {
  name: 'VfdChangeSetItemStatus',
  description: 'VFD change set item status',
});

registerEnumType(VfdAuditAction, {
  name: 'VfdAuditAction',
  description: 'VFD audit trail action types',
});
