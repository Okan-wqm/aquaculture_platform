import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType } from '../entities/vfd.enums';

/**
 * Yaskawa Register Mappings
 * Supports: A1000, V1000, GA500, GA700, U1000, J1000, CR700
 *
 * Register Structure: Parameters Uxxxx, monitor parameters typically at 0x2100+
 * Modbus Register = Parameter × 2 (for holding registers)
 */
export const YASKAWA_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status bits',
    category: VfdParameterCategory.STATUS,
    registerAddress: 0x2100, // Drive status register
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Ready', description: 'Drive ready' },
      { bit: 1, name: 'Running', description: 'Motor running' },
      { bit: 2, name: 'Direction', description: 'Reverse direction' },
      { bit: 3, name: 'Fault', description: 'Fault active' },
      { bit: 4, name: 'At Speed', description: 'At reference speed' },
      { bit: 5, name: 'Alarm', description: 'Minor alarm' },
      { bit: 6, name: 'DC Bus Charged', description: 'DC bus charged' },
      { bit: 7, name: 'Home Complete', description: 'Homing complete' },
      { bit: 8, name: 'Speed Search', description: 'Speed search active' },
      { bit: 9, name: 'Program Running', description: 'DriveWorksEZ running' },
      { bit: 10, name: 'Speed Agree', description: 'Output matches reference' },
      { bit: 11, name: 'Zero Speed', description: 'At zero speed' },
      { bit: 12, name: 'Torque Limit', description: 'Torque limited' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'Timer Complete', description: 'Timer complete' },
      { bit: 15, name: 'Base Block', description: 'Base block active' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'fault_status',
    displayName: 'Fault Status',
    description: 'Fault status register',
    category: VfdParameterCategory.STATUS,
    registerAddress: 0x2101, // Fault status
    dataType: VfdDataType.UINT16,
    displayOrder: 2,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'U1-02 - Output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2102, // U1-02
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 400,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'U1-03 - Output current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2103, // U1-03
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'A',
    displayOrder: 11,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 2000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'U1-05 - Motor speed',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2105, // U1-05
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 12,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: -10000,
    maxValue: 10000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'output_voltage',
    displayName: 'Output Voltage',
    description: 'U1-04 - Output voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2104, // U1-04
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 13,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'U1-07 - DC bus voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2107, // U1-07
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'U1-08 - Output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2108, // U1-08
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'kW',
    displayOrder: 15,
    isCritical: true,
    recommendedPollIntervalMs: 1000,
    minValue: -500,
    maxValue: 500,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'U1-09 - Motor torque reference',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2109, // U1-09
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 16,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'frequency_reference',
    displayName: 'Frequency Reference',
    description: 'U1-01 - Frequency reference',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2101, // U1-01
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 17,
    recommendedPollIntervalMs: 500,
    minValue: -400,
    maxValue: 400,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'torque_reference',
    displayName: 'Torque Reference',
    description: 'U1-10 - Torque reference',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x210a, // U1-10
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 18,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'igbt_temp',
    displayName: 'IGBT Temperature',
    description: 'U1-21 - IGBT temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x2115, // U1-21
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 30,
    isCritical: true,
    recommendedPollIntervalMs: 5000,
    minValue: -20,
    maxValue: 150,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal Load',
    description: 'U1-22 - Motor overload status',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x2116, // U1-22
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'drive_thermal',
    displayName: 'Drive Thermal Load',
    description: 'U1-23 - Drive overload status',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x2117, // U1-23
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 32,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'kwh_counter',
    displayName: 'kWh Counter',
    description: 'U4-01/02 - Total kWh',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2401, // U4-01
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'U4-03/04 - Motor run time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2403, // U4-03
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'U4-05/06 - Power on time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2405, // U4-05
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'start_count',
    displayName: 'Start Count',
    description: 'U4-07/08 - Number of starts',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2407, // U4-07
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'fault_code',
    displayName: 'Fault Code',
    description: 'U2-01 - Current fault',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x2201, // U2-01
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'fault_trace_1',
    displayName: 'Fault Trace 1',
    description: 'U2-02 - Previous fault 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x2202, // U2-02
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    recommendedPollIntervalMs: 5000,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'minor_alarm',
    displayName: 'Minor Alarm',
    description: 'U2-10 - Minor fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x220a, // U2-10
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'MEMOBUS control word',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x0001, // Control register
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Run', description: 'Run command' },
      { bit: 1, name: 'Direction', description: 'Direction (0=FWD, 1=REV)' },
      { bit: 2, name: 'External Fault', description: 'External fault input' },
      { bit: 3, name: 'Fault Reset', description: 'Fault reset' },
      { bit: 4, name: 'Multispeed 1', description: 'Multi-speed ref 1' },
      { bit: 5, name: 'Multispeed 2', description: 'Multi-speed ref 2' },
      { bit: 6, name: 'Multispeed 3', description: 'Multi-speed ref 3' },
      { bit: 7, name: 'Multispeed 4', description: 'Multi-speed ref 4' },
      { bit: 8, name: 'Jog', description: 'Jog command' },
      { bit: 9, name: 'Accel/Decel', description: 'Accel/Decel select' },
      { bit: 10, name: 'DC Braking', description: 'DC braking command' },
      { bit: 11, name: 'Base Block', description: 'Base block command' },
      { bit: 12, name: 'Fault Hold', description: 'Fault hold' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'Reserved', description: 'Reserved' },
      { bit: 15, name: 'Reserved', description: 'Reserved' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.YASKAWA,
    parameterName: 'frequency_command',
    displayName: 'Frequency Command',
    description: 'Frequency reference via MEMOBUS',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x0002, // Frequency reference
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: 0,
    maxValue: 400,
  },
];

/**
 * Yaskawa specific control word values
 */
export const YASKAWA_CONTROL_COMMANDS = {
  STOP: 0x0000,
  RUN_FORWARD: 0x0001,
  RUN_REVERSE: 0x0003,
  FAULT_RESET: 0x0008,
  JOG_FORWARD: 0x0101,
  JOG_REVERSE: 0x0103,
  BASE_BLOCK: 0x0800,
  DC_BRAKING: 0x0401,
};

/**
 * Yaskawa default serial configuration
 */
export const YASKAWA_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 2,
  timeout: 1000,
  retryCount: 3,
};
