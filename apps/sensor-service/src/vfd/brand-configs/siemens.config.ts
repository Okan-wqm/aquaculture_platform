import { VfdRegisterMappingInput, VfdConfigRegisterInput } from '../entities/vfd.types';
import { VfdBrand, VfdParameterCategory, VfdDataType, VfdParameterGroup, RiskLevel } from '../entities/vfd.enums';

/**
 * Siemens SINAMICS Register Mappings
 * Supports: G120, G120C, G120X, S120, S150, V20, V90
 *
 * Parameter Structure: P0xxx (Read/Write), r0xxx (Read Only)
 * Register = Parameter Number (direct mapping for most parameters)
 */
export const SIEMENS_SINAMICS_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'status_word_1',
    displayName: 'Status Word 1',
    description: 'ZSW1 - Main status word',
    category: VfdParameterCategory.STATUS,
    registerAddress: 52, // r0052
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Ready to Switch On', description: 'Ready to switch on' },
      { bit: 1, name: 'Ready to Operate', description: 'Ready to operate' },
      { bit: 2, name: 'Operation Enabled', description: 'Operation enabled' },
      { bit: 3, name: 'Fault Active', description: 'Fault present' },
      { bit: 4, name: 'Coast Stop', description: 'OFF2 - coast stop not active' },
      { bit: 5, name: 'Quick Stop', description: 'OFF3 - quick stop not active' },
      { bit: 6, name: 'Switching On Inhibited', description: 'Switch on inhibited' },
      { bit: 7, name: 'Warning', description: 'Warning active' },
      { bit: 8, name: 'Setpoint/Speed Deviation', description: 'Speed within tolerance' },
      { bit: 9, name: 'Control Request', description: 'Control requested' },
      { bit: 10, name: 'f/n Setpoint Reached', description: 'Reference speed reached' },
      { bit: 11, name: 'I Limit', description: 'Current limit active' },
      { bit: 12, name: 'Holding Brake Open', description: 'Motor brake open' },
      { bit: 13, name: 'Motor Overtemp Warning', description: 'Motor temperature warning' },
      { bit: 14, name: 'Motor Rotating CW', description: 'Motor rotating clockwise' },
      { bit: 15, name: 'Inverter Overtemp Warning', description: 'Drive overtemperature warning' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'status_word_2',
    displayName: 'Status Word 2',
    description: 'ZSW2 - Extended status word',
    category: VfdParameterCategory.STATUS,
    registerAddress: 53, // r0053
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Drive Ready', description: 'Drive ready' },
      { bit: 1, name: 'Pulses Enabled', description: 'PWM pulses enabled' },
      { bit: 2, name: 'Technology Controller Active', description: 'PID active' },
      { bit: 3, name: 'Current Actual Smoothed', description: 'Smooth current available' },
    ],
    displayOrder: 2,
    recommendedPollIntervalMs: 500,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 24, // r0024
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 650,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Actual motor speed',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 21, // r0021
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 11,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: -10000,
    maxValue: 10000,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Actual motor current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 27, // r0027
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'A',
    displayOrder: 12,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 2000,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Actual motor torque as percentage of rated',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 26, // r0026
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 13,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_voltage',
    displayName: 'Motor Voltage',
    description: 'Actual motor voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 25, // r0025
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 25, // r0025
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 15,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Actual output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 32, // r0032
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'kW',
    displayOrder: 16,
    isCritical: true,
    recommendedPollIntervalMs: 1000,
    minValue: -500,
    maxValue: 500,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'power_factor',
    displayName: 'Power Factor',
    description: 'Motor power factor (cos phi)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 33, // r0033
    dataType: VfdDataType.INT16,
    scalingFactor: 0.001,
    displayOrder: 17,
    recommendedPollIntervalMs: 2000,
    minValue: 0,
    maxValue: 1,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'speed_setpoint',
    displayName: 'Speed Setpoint',
    description: 'Current speed setpoint',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 22, // r0022
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 18,
    recommendedPollIntervalMs: 500,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'drive_temp',
    displayName: 'Drive Temperature',
    description: 'Inverter temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 35, // r0035
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 30,
    isCritical: true,
    recommendedPollIntervalMs: 5000,
    minValue: -20,
    maxValue: 100,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal Load',
    description: 'Motor thermal utilization',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 34, // r0034
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 150,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'motor_temp',
    displayName: 'Motor Temperature',
    description: 'Motor temperature from sensor (if available)',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 36, // r0036
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 32,
    recommendedPollIntervalMs: 5000,
    minValue: -20,
    maxValue: 200,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'energy_consumption',
    displayName: 'Energy Consumption',
    description: 'Total energy consumption',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 39, // r0039
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'Motor run time hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 80, // r0080
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'Drive power on time hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 78, // r0078
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'fault_code',
    displayName: 'Fault Code',
    description: 'Current fault code (Fxxxx)',
    category: VfdParameterCategory.FAULT,
    registerAddress: 947, // r0947
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'warning_code',
    displayName: 'Warning Code',
    description: 'Current warning code (Axxxx)',
    category: VfdParameterCategory.FAULT,
    registerAddress: 952, // r0952
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'last_fault_code',
    displayName: 'Last Fault Code',
    description: 'Previous fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 948, // r0948
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    recommendedPollIntervalMs: 5000,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'control_word_1',
    displayName: 'Control Word 1',
    description: 'STW1 - Main control word',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 40100, // P0700 related
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'ON', description: 'ON/OFF1 command' },
      { bit: 1, name: 'OFF2', description: 'Coast stop (0=coast)' },
      { bit: 2, name: 'OFF3', description: 'Quick stop (0=quick stop)' },
      { bit: 3, name: 'Enable Operation', description: 'Enable operation' },
      { bit: 4, name: 'Ramp Gen Enable', description: 'Enable ramp generator' },
      { bit: 5, name: 'Ramp Gen Continue', description: 'Continue ramp generator' },
      { bit: 6, name: 'Setpoint Enable', description: 'Enable setpoint' },
      { bit: 7, name: 'Acknowledge Fault', description: 'Fault acknowledgement' },
      { bit: 8, name: 'Reserved', description: 'Reserved' },
      { bit: 9, name: 'Reserved', description: 'Reserved' },
      { bit: 10, name: 'Control by PLC', description: 'Control by PLC' },
      { bit: 11, name: 'Direction', description: 'Reverse (0=FWD, 1=REV)' },
      { bit: 12, name: 'Reserved', description: 'Reserved' },
      { bit: 13, name: 'MOP Up', description: 'Motorized pot up' },
      { bit: 14, name: 'MOP Down', description: 'Motorized pot down' },
      { bit: 15, name: 'Reserved', description: 'Reserved' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'speed_setpoint_main',
    displayName: 'Speed Setpoint',
    description: 'Main speed setpoint',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 1000, // P1000
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: '%',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: -100,
    maxValue: 100,
  },
  {
    brand: VfdBrand.SIEMENS,
    parameterName: 'frequency_setpoint',
    displayName: 'Frequency Setpoint',
    description: 'Fixed frequency setpoint',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 1001, // P1001
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 62,
    recommendedPollIntervalMs: 200,
    minValue: 0,
    maxValue: 650,
  },
];

/**
 * Siemens specific control word values (PROFIdrive)
 */
export const SIEMENS_CONTROL_COMMANDS = {
  OFF1: 0x047e,           // OFF1 - ramp stop
  OFF2: 0x047d,           // OFF2 - coast stop
  OFF3: 0x047b,           // OFF3 - quick stop
  READY: 0x047e,          // Ready state
  RUN_FORWARD: 0x047f,    // Run forward
  RUN_REVERSE: 0x0c7f,    // Run reverse
  ACKNOWLEDGE: 0x04fe,    // Acknowledge fault
  JOG_FORWARD: 0x057f,    // Jog forward
  JOG_REVERSE: 0x0d7f,    // Jog reverse
};

/**
 * Siemens SINAMICS G120 Configuration Registers for Remote Programming
 * Parameter Structure: P0xxx (Read/Write), r0xxx (Read Only)
 */
export const SIEMENS_G120_CONFIG_REGISTERS: VfdConfigRegisterInput[] = [
  // ============ RAMP_TIMES ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'accel_time', displayName: 'Acceleration Time',
    description: 'Ramp-up time P1120',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 1120, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 's',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 6500,
    defaultValue: 10, step: 0.01, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P1120' },
  },
  {
    brand: VfdBrand.SIEMENS, parameterName: 'decel_time', displayName: 'Deceleration Time',
    description: 'Ramp-down time P1121',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 1121, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 's',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 6500,
    defaultValue: 10, step: 0.01, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P1121' },
  },

  // ============ FREQUENCY_LIMITS ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'min_frequency', displayName: 'Minimum Frequency',
    description: 'Minimum motor frequency P1080',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.FREQUENCY_LIMITS,
    registerAddress: 1080, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 650,
    defaultValue: 0, step: 0.01, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P1080' },
  },
  {
    brand: VfdBrand.SIEMENS, parameterName: 'max_frequency', displayName: 'Maximum Frequency',
    description: 'Maximum motor frequency P1082',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.FREQUENCY_LIMITS,
    registerAddress: 1082, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0.01, maxValue: 650,
    defaultValue: 50, step: 0.01, riskLevel: RiskLevel.HIGH, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P1082' },
  },

  // ============ MOTOR_NAMEPLATE ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'motor_nom_voltage', displayName: 'Motor Rated Voltage',
    description: 'Motor rated voltage P0304',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 304, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 'V',
    isWritable: true, isReadable: true, minValue: 10, maxValue: 2000,
    defaultValue: 400, step: 1, riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { siemensParameter: 'P0304' },
  },
  {
    brand: VfdBrand.SIEMENS, parameterName: 'motor_nom_current', displayName: 'Motor Rated Current',
    description: 'Motor rated current P0305',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 305, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'A',
    isWritable: true, isReadable: true, minValue: 0.01, maxValue: 10000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { siemensParameter: 'P0305' },
  },
  {
    brand: VfdBrand.SIEMENS, parameterName: 'motor_nom_power', displayName: 'Motor Rated Power',
    description: 'Motor rated power P0307',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 307, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'kW',
    isWritable: true, isReadable: true, minValue: 0.01, maxValue: 2000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { siemensParameter: 'P0307' },
  },
  {
    brand: VfdBrand.SIEMENS, parameterName: 'motor_nom_speed', displayName: 'Motor Rated Speed',
    description: 'Motor rated speed P0311',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 311, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: 'RPM',
    isWritable: true, isReadable: true, minValue: 1, maxValue: 40000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { siemensParameter: 'P0311' },
  },

  // ============ CURRENT_LIMITS ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'current_limit', displayName: 'Current Limit',
    description: 'Motor current limit as % P0640',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.CURRENT_LIMITS,
    registerAddress: 640, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: '%',
    isWritable: true, isReadable: true, minValue: 10, maxValue: 400,
    defaultValue: 150, step: 1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P0640' },
  },

  // ============ JOG ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'jog_frequency', displayName: 'JOG Setpoint',
    description: 'Fixed frequency for JOG P1058',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.JOG,
    registerAddress: 1058, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 650,
    defaultValue: 5, step: 0.01, riskLevel: RiskLevel.LOW, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P1058' },
  },

  // ============ PROTECTION ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'motor_overload_protection', displayName: 'Motor Overload Protection',
    description: 'Motor I2t overload protection enable P0610',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.PROTECTION,
    registerAddress: 610, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: '',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 3,
    defaultValue: 1, step: 1, riskLevel: RiskLevel.CRITICAL, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P0610' },
  },

  // ============ COMMUNICATION ============
  {
    brand: VfdBrand.SIEMENS, parameterName: 'modbus_address', displayName: 'USS/Modbus Address',
    description: 'USS or Modbus station address P2011',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.COMMUNICATION,
    registerAddress: 2011, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: '',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 247,
    defaultValue: 1, step: 1, riskLevel: RiskLevel.LOW, requiresMotorStop: false,
    functionCode: 6, metadata: { siemensParameter: 'P2011' },
  },
];

/**
 * Siemens default serial configuration
 */
export const SIEMENS_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'even' as const,
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};

/**
 * Siemens SINAMICS fault code definitions (common Fxxxx codes)
 */
export const SIEMENS_FAULT_CODES: Record<number, string> = {
  0: 'No Fault',
  1: 'Overcurrent',
  2: 'DC Bus Overvoltage',
  3: 'Inverter I2t',
  4: 'Motor I2t',
  5: 'DC Bus Undervoltage',
  7: 'Motor Overtemperature',
  8: 'Heatsink Overtemperature',
  11: 'Motor Stall',
  12: 'Phase Failure',
  13: 'Internal Fault',
  14: 'Ground Fault',
  15: 'External Fault 1',
  18: 'Power Stack',
  25: 'EEPROM Fault',
  30: 'Fieldbus Fault',
  35: 'Input Phase Loss',
  40: 'Motor Overtemperature Sensor',
  51: 'Parameter Checksum Error',
  52: 'Safe Torque Off',
  60: 'Technology Controller Fault',
  72: 'Motor Phase Loss',
  80: 'Missing Motor Parameter',
};
