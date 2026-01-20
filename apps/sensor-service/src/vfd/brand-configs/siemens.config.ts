import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from '../entities/vfd.enums';
import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';

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
    registerAddress: 26, // r0026 (different register for DC bus)
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
