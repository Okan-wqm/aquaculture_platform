import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from '../entities/vfd.enums';

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
