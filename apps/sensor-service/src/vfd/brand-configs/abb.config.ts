import { VfdRegisterMappingInput, VfdConfigRegisterInput } from '../entities/vfd.types';
import { VfdBrand, VfdParameterCategory, VfdDataType, VfdParameterGroup, RiskLevel } from '../entities/vfd.enums';

/**
 * ABB ACS Series Register Mappings
 * Supports: ACS580, ACS880, ACS355, ACS310, ACS550, ACS800, ACS1000
 *
 * 16-bit Register: Register = 40000 + (100 × Group) + Index
 * 32-bit Register: Register = 420000 + (200 × Group) + (2 × Index)
 */
export const ABB_ACS_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status bits (ZSW)',
    category: VfdParameterCategory.STATUS,
    registerAddress: 400051, // Actual: 51
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Ready to Switch On', description: 'Drive ready to switch on' },
      { bit: 1, name: 'Switched On', description: 'Main contactor closed' },
      { bit: 2, name: 'Operation Enabled', description: 'Drive operation enabled' },
      { bit: 3, name: 'Fault', description: 'Fault active' },
      { bit: 4, name: 'Voltage Enabled', description: 'DC bus voltage enabled' },
      { bit: 5, name: 'Quick Stop', description: 'Quick stop not active' },
      { bit: 6, name: 'Switch On Disabled', description: 'Switch on inhibited' },
      { bit: 7, name: 'Warning', description: 'Warning active' },
      { bit: 8, name: 'At Setpoint', description: 'Speed at reference' },
      { bit: 9, name: 'Remote', description: 'Remote control active' },
      { bit: 10, name: 'Target Reached', description: 'Target speed reached' },
      { bit: 11, name: 'Internal Limit', description: 'Internal limit active' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'actual_speed',
    displayName: 'Actual Speed',
    description: 'Actual motor speed percentage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 400052, // Actual: 52
    dataType: VfdDataType.INT16,
    scalingFactor: 0.005, // ±20000 = 100%
    unit: '%',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: -100,
    maxValue: 100,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40106, // Group 01, Index 06
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 11,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 500,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Actual motor current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40107, // Group 01, Index 07
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'A',
    displayOrder: 12,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 2000,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Actual motor torque percentage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40110, // Group 01, Index 10
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: '%',
    displayOrder: 13,
    recommendedPollIntervalMs: 500,
    minValue: -200,
    maxValue: 200,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40111, // Group 01, Index 11
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'motor_voltage',
    displayName: 'Motor Voltage',
    description: 'Actual motor voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40113, // Group 01, Index 13
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: 'V',
    displayOrder: 15,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Actual output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40114, // Group 01, Index 14
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'kW',
    displayOrder: 16,
    isCritical: true,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Actual motor speed in RPM',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40102, // Group 01, Index 02
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 17,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 10000,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'drive_temp',
    displayName: 'Drive Temperature',
    description: 'Drive internal temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40511, // Group 05, Index 11
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 30,
    isCritical: true,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 100,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal',
    description: 'Calculated motor thermal load',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40901, // Group 09, Index 01
    dataType: VfdDataType.INT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 100,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'energy_consumption',
    displayName: 'Energy Consumption',
    description: 'Total energy consumption',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40120, // Group 01, Index 20
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'Total motor running hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40503, // Group 05, Index 03
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'Total drive power on hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40501, // Group 05, Index 01
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'fault_code',
    displayName: 'Fault Code',
    description: 'Last active fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40411, // Group 04, Index 11
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'warning_word',
    displayName: 'Warning Word',
    description: 'Active warnings bitmap',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40421, // Group 04, Index 21
    dataType: VfdDataType.UINT16,
    isBitField: true,
    displayOrder: 51,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.ABB,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'Control word (STW)',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 400001, // Actual: 1
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Switch On', description: 'Switch on command' },
      { bit: 1, name: 'Enable Voltage', description: 'Enable voltage' },
      { bit: 2, name: 'Quick Stop', description: 'Quick stop (inverted)' },
      { bit: 3, name: 'Enable Operation', description: 'Enable operation' },
      { bit: 4, name: 'Ramp Out Zero', description: 'Ramp output to zero' },
      { bit: 5, name: 'Ramp Hold', description: 'Ramp hold' },
      { bit: 6, name: 'Ramp In Zero', description: 'Ramp input from zero' },
      { bit: 7, name: 'Reset', description: 'Fault reset' },
      { bit: 10, name: 'Control Bit 0', description: 'Control bit 0' },
      { bit: 11, name: 'Direction', description: 'Direction (0=FWD, 1=REV)' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.ABB,
    parameterName: 'speed_reference',
    displayName: 'Speed Reference',
    description: 'Speed reference percentage',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 400002, // Actual: 2
    dataType: VfdDataType.INT16,
    scalingFactor: 0.005, // ±20000 = 100%
    unit: '%',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: -100,
    maxValue: 100,
  },
];

/**
 * ABB specific control word values
 */
export const ABB_CONTROL_COMMANDS = {
  SHUTDOWN: 0x0006,
  SWITCH_ON: 0x0007,
  ENABLE_OPERATION: 0x000f,
  RUN_FORWARD: 0x000f,
  RUN_REVERSE: 0x080f,
  QUICK_STOP: 0x0002,
  DISABLE_VOLTAGE: 0x0000,
  FAULT_RESET: 0x0080,
};

/**
 * ABB ACS Series Configuration Registers for Remote Programming
 * Register: 40000 + (100 x Group) + Index for 16-bit params
 * Groups: 20=Start/Stop, 22=Accel/Decel, 30=Limits, 99=Motor data
 */
export const ABB_ACS_CONFIG_REGISTERS: VfdConfigRegisterInput[] = [
  // ============ RAMP_TIMES ============
  {
    brand: VfdBrand.ABB, parameterName: 'accel_time_1', displayName: 'Acceleration Time 1',
    description: 'Acceleration time 1 — Group 22 parameter 02',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 42201, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 's',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 1800,
    defaultValue: 5, step: 0.1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 22, abbIndex: 1, abbParameter: '22.01' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'decel_time_1', displayName: 'Deceleration Time 1',
    description: 'Deceleration time 1 — Group 22 parameter 02',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 42202, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 's',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 1800,
    defaultValue: 5, step: 0.1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 22, abbIndex: 2, abbParameter: '22.02' },
  },

  // ============ FREQUENCY_LIMITS ============
  {
    brand: VfdBrand.ABB, parameterName: 'min_frequency', displayName: 'Minimum Frequency',
    description: 'Minimum output frequency — Group 20 parameter 01',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.FREQUENCY_LIMITS,
    registerAddress: 42001, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 500,
    defaultValue: 0, step: 0.1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 20, abbIndex: 1, abbParameter: '20.01' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'max_frequency', displayName: 'Maximum Frequency',
    description: 'Maximum output frequency — Group 20 parameter 02',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.FREQUENCY_LIMITS,
    registerAddress: 42002, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0.1, maxValue: 500,
    defaultValue: 50, step: 0.1, riskLevel: RiskLevel.HIGH, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 20, abbIndex: 2, abbParameter: '20.02' },
  },

  // ============ MOTOR_NAMEPLATE ============
  {
    brand: VfdBrand.ABB, parameterName: 'motor_nom_power', displayName: 'Motor Nominal Power',
    description: 'Motor nameplate power — Group 99 parameter 04',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 49904, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: 'kW',
    isWritable: true, isReadable: true, minValue: 0.12, maxValue: 2000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { abbGroup: 99, abbIndex: 4, abbParameter: '99.04' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'motor_nom_voltage', displayName: 'Motor Nominal Voltage',
    description: 'Motor nameplate voltage — Group 99 parameter 05',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 49905, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: 'V',
    isWritable: true, isReadable: true, minValue: 100, maxValue: 1000,
    defaultValue: 400, step: 1, riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { abbGroup: 99, abbIndex: 5, abbParameter: '99.05' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'motor_nom_current', displayName: 'Motor Nominal Current',
    description: 'Motor nameplate current — Group 99 parameter 06',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 49906, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 'A',
    isWritable: true, isReadable: true, minValue: 0.1, maxValue: 5000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { abbGroup: 99, abbIndex: 6, abbParameter: '99.06' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'motor_nom_speed', displayName: 'Motor Nominal Speed',
    description: 'Motor nameplate speed — Group 99 parameter 07',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.MOTOR_NAMEPLATE,
    registerAddress: 49907, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: 'RPM',
    isWritable: true, isReadable: true, minValue: 100, maxValue: 30000,
    riskLevel: RiskLevel.HIGH, requiresMotorStop: true,
    functionCode: 6, metadata: { abbGroup: 99, abbIndex: 7, abbParameter: '99.07' },
  },

  // ============ CURRENT_LIMITS ============
  {
    brand: VfdBrand.ABB, parameterName: 'current_limit', displayName: 'Current Limit',
    description: 'Maximum motor current as % of nominal — Group 20 parameter 07',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.CURRENT_LIMITS,
    registerAddress: 42007, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: '%',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 300,
    defaultValue: 150, step: 1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 20, abbIndex: 7, abbParameter: '20.07' },
  },

  // ============ JOG ============
  {
    brand: VfdBrand.ABB, parameterName: 'jog_frequency', displayName: 'Jog Speed Reference',
    description: 'Jog speed reference frequency — Group 21 parameter 10',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.JOG,
    registerAddress: 42110, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 'Hz',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 500,
    defaultValue: 5, step: 0.1, riskLevel: RiskLevel.LOW, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 21, abbIndex: 10, abbParameter: '21.10' },
  },

  // ============ PROTECTION ============
  {
    brand: VfdBrand.ABB, parameterName: 'motor_thermal_protection', displayName: 'Motor Thermal Protection',
    description: 'Motor thermal protection mode — Group 30 parameter 01',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.PROTECTION,
    registerAddress: 43001, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: '',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 3,
    defaultValue: 1, step: 1, riskLevel: RiskLevel.CRITICAL, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 30, abbIndex: 1, abbParameter: '30.01' },
  },

  // ============ COMMUNICATION ============
  {
    brand: VfdBrand.ABB, parameterName: 'modbus_address', displayName: 'Modbus Station ID',
    description: 'Modbus RTU station address — Group 53 parameter 01',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.COMMUNICATION,
    registerAddress: 45301, dataType: VfdDataType.UINT16, scalingFactor: 1, unit: '',
    isWritable: true, isReadable: true, minValue: 1, maxValue: 247,
    defaultValue: 1, step: 1, riskLevel: RiskLevel.LOW, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 53, abbIndex: 1, abbParameter: '53.01' },
  },

  // ============ PID_CONTROLLER ============
  {
    brand: VfdBrand.ABB, parameterName: 'pid_gain', displayName: 'PID Gain',
    description: 'PID controller gain — Group 40 parameter 01',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.PID_CONTROLLER,
    registerAddress: 44001, dataType: VfdDataType.UINT16, scalingFactor: 0.01, unit: '',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 1000,
    defaultValue: 100, step: 1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 40, abbIndex: 1, abbParameter: '40.01' },
  },
  {
    brand: VfdBrand.ABB, parameterName: 'pid_integration_time', displayName: 'PID Integration Time',
    description: 'PID controller integration time — Group 40 parameter 02',
    category: VfdParameterCategory.CONFIGURATION, group: VfdParameterGroup.PID_CONTROLLER,
    registerAddress: 44002, dataType: VfdDataType.UINT16, scalingFactor: 0.1, unit: 's',
    isWritable: true, isReadable: true, minValue: 0, maxValue: 3200,
    defaultValue: 10, step: 0.1, riskLevel: RiskLevel.MEDIUM, requiresMotorStop: false,
    functionCode: 6, metadata: { abbGroup: 40, abbIndex: 2, abbParameter: '40.02' },
  },
];

/**
 * ABB default serial configuration
 */
export const ABB_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};

/**
 * ABB ACS fault code definitions (common codes)
 */
export const ABB_FAULT_CODES: Record<number, string> = {
  0: 'No Fault',
  1: 'Overcurrent',
  2: 'DC Overvoltage',
  3: 'Device Overtemperature',
  4: 'Short Circuit',
  5: 'Motor Overtemperature',
  6: 'Analog Input Loss',
  7: 'External Fault',
  8: 'Output Phase Loss',
  9: 'Undervoltage',
  10: 'AI1 Low Fault',
  11: 'AI2 Low Fault',
  16: 'Earth Fault',
  22: 'IGBT Overtemperature',
  23: 'Charging Fault',
  25: 'Motor Stall',
  31: 'PPCC Link Fault',
  32: 'Supply Phase Loss',
  34: 'ID Run Fault',
  51: 'Parameter Restore Fault',
  52: 'Fieldbus Communication Loss',
  53: 'Fieldbus Fault',
  64: 'Encoder Fault',
};
