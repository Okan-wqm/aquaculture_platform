import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from '../entities/vfd.enums';
import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';

/**
 * Mitsubishi Electric Inverter Register Mappings
 * Supports: FR-A800, FR-A700, FR-E800, FR-E700, FR-D700, FR-F800, FR-S500
 *
 * Register Structure: Parameters Pr.xxx
 * Modbus register address varies by parameter group
 */
export const MITSUBISHI_FR_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status register',
    category: VfdParameterCategory.STATUS,
    registerAddress: 200, // Status monitor
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Inverter Running', description: 'Inverter running' },
      { bit: 1, name: 'Forward Command', description: 'Forward rotation command' },
      { bit: 2, name: 'Reverse Command', description: 'Reverse rotation command' },
      { bit: 3, name: 'Fault', description: 'Fault trip' },
      { bit: 4, name: 'Frequency Agree', description: 'Output=Reference frequency' },
      { bit: 5, name: 'Run Ready', description: 'Ready to run' },
      { bit: 6, name: 'Frequency Detected', description: 'Output above threshold' },
      { bit: 7, name: 'Instantaneous Overload', description: 'OL trip warning' },
      { bit: 8, name: 'Overload Warning', description: 'OL early warning' },
      { bit: 9, name: 'PID Deviation', description: 'PID deviation' },
      { bit: 10, name: 'Output Current High', description: 'Current above limit' },
      { bit: 11, name: 'Output Freq Upper Limit', description: 'At upper limit' },
      { bit: 12, name: 'Output Freq Lower Limit', description: 'At lower limit' },
      { bit: 13, name: 'Alarm', description: 'Minor alarm' },
      { bit: 14, name: 'Second Function', description: 'Second function active' },
      { bit: 15, name: 'Net Mode', description: 'Network control mode' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 201, // Output frequency monitor
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
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Output current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 202, // Output current monitor
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
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'output_voltage',
    displayName: 'Output Voltage',
    description: 'Output voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 203, // Output voltage monitor
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 12,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Motor speed in RPM',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 206, // Speed monitor
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 13,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: -10000,
    maxValue: 10000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 205, // DC bus monitor
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 207, // Power monitor
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'kW',
    displayOrder: 15,
    isCritical: true,
    recommendedPollIntervalMs: 1000,
    minValue: -500,
    maxValue: 500,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Output torque percentage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 208, // Torque monitor
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 16,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'frequency_setting',
    displayName: 'Frequency Setting',
    description: 'Frequency command value',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 204, // Frequency setting
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 17,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 400,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'heatsink_temp',
    displayName: 'Heatsink Temperature',
    description: 'Inverter fin temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 209, // Temperature monitor
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
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal',
    description: 'Electronic thermal relay load',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 210, // Motor thermal monitor
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'inverter_thermal',
    displayName: 'Inverter Thermal',
    description: 'Inverter thermal load',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 211, // Inverter thermal monitor
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
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'accumulated_power',
    displayName: 'Accumulated Power',
    description: 'Total energy consumption',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 558, // Pr.558 Cumulative power
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'running_time',
    displayName: 'Running Time',
    description: 'Total motor run time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 559, // Pr.559 Running time
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'power_on_time',
    displayName: 'Power On Time',
    description: 'Total power on time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 560, // Pr.560 Power-on time
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'start_count',
    displayName: 'Start Count',
    description: 'Number of inverter starts',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 561, // Pr.561 Number of starts
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'current_fault',
    displayName: 'Current Fault',
    description: 'Current fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 100, // Current fault
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'fault_history_1',
    displayName: 'Fault History 1',
    description: 'Pr.990 Fault history 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 990, // Fault history
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    recommendedPollIntervalMs: 5000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'fault_history_2',
    displayName: 'Fault History 2',
    description: 'Pr.991 Fault history 2',
    category: VfdParameterCategory.FAULT,
    registerAddress: 991, // Fault history 2
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    recommendedPollIntervalMs: 5000,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'alarm_code',
    displayName: 'Alarm Code',
    description: 'Current alarm/warning',
    category: VfdParameterCategory.FAULT,
    registerAddress: 212, // Alarm monitor
    dataType: VfdDataType.UINT16,
    displayOrder: 53,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'Operation command',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x0000, // Operation command
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Run/Stop', description: 'Run command' },
      { bit: 1, name: 'Reverse', description: 'Forward/Reverse' },
      { bit: 2, name: 'High Speed', description: 'RH - High speed' },
      { bit: 3, name: 'Medium Speed', description: 'RM - Medium speed' },
      { bit: 4, name: 'Low Speed', description: 'RL - Low speed' },
      { bit: 5, name: 'Jog', description: 'JOG command' },
      { bit: 6, name: 'Second Function', description: 'RT - Second function' },
      { bit: 7, name: 'Fault Reset', description: 'RES - Fault reset' },
      { bit: 8, name: 'Accel/Decel Time', description: 'AUX - A/D time switch' },
      { bit: 9, name: 'Stop', description: 'MRS - Output stop' },
      { bit: 10, name: 'Self Resetting', description: 'CS - Self reset select' },
      { bit: 11, name: 'Reserved', description: 'Reserved' },
      { bit: 12, name: 'Reserved', description: 'Reserved' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'Reserved', description: 'Reserved' },
      { bit: 15, name: 'Reserved', description: 'Reserved' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'frequency_command',
    displayName: 'Frequency Command',
    description: 'Frequency setting via communication',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x0001, // Frequency command
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: 0,
    maxValue: 400,
  },
  {
    brand: VfdBrand.MITSUBISHI,
    parameterName: 'torque_limit',
    displayName: 'Torque Limit',
    description: 'Torque limit setting',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x0002, // Torque limit
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    isWritable: true,
    displayOrder: 62,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 300,
  },
];

/**
 * Mitsubishi specific control word values
 */
export const MITSUBISHI_CONTROL_COMMANDS = {
  STOP: 0x0000,
  RUN_FORWARD: 0x0001,
  RUN_REVERSE: 0x0003,
  JOG_FORWARD: 0x0021,
  JOG_REVERSE: 0x0023,
  FAULT_RESET: 0x0080,
  COAST_STOP: 0x0200, // MRS bit
};

/**
 * Mitsubishi default serial configuration
 */
export const MITSUBISHI_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 1,
  timeout: 500,
  retryCount: 3,
};

/**
 * Mitsubishi fault code definitions (common codes)
 */
export const MITSUBISHI_FAULT_CODES: Record<number, string> = {
  0: 'No Fault',
  1: 'OC1 - Over-current trip (acceleration)',
  2: 'OC2 - Over-current trip (deceleration)',
  3: 'OC3 - Over-current trip (constant speed)',
  4: 'OV1 - Regenerative over-voltage (acceleration)',
  5: 'OV2 - Regenerative over-voltage (deceleration)',
  6: 'OV3 - Regenerative over-voltage (constant speed)',
  7: 'THM - Motor electronic thermal relay trip',
  8: 'THT - Transistor electronic thermal trip',
  9: 'FIN - Fin overheat',
  10: 'CPU - CPU error',
  11: 'ILF - Input phase loss',
  12: 'OLT - Stall prevention (over-torque)',
  13: 'BE - Brake transistor error',
  14: 'GF - Output ground fault',
  15: 'LF - Output phase loss',
  16: 'OHT - External thermal trip',
  17: 'PTC - PTC thermistor trip',
  18: 'PR - Parameter error',
  19: 'PUE - PU disconnect',
  20: 'RET - Retry count exceeded',
  21: 'PE - Parameter write error',
  22: 'PE2 - EEPROM error',
  23: 'UV - Under-voltage trip',
  24: 'RFS - Memory error',
  25: 'OS - Overspeed',
  26: 'OD - Deviation excessive',
  27: 'POF - Power off',
  28: 'USF - Under frequency',
  29: 'OSF - Over frequency',
  30: 'FAN - Cooling fan error',
};
