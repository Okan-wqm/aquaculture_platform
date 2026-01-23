import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType } from '../entities/vfd.enums';

/**
 * Schneider Electric Altivar Register Mappings
 * Supports: ATV12, ATV212, ATV312, ATV320, ATV340, ATV600, ATV630, ATV930
 *
 * Register Structure: Based on Modbus standard with Schneider addressing
 * Logic addresses: 3xxx for holding registers, 4xxxx for input registers
 */
export const SCHNEIDER_ALTIVAR_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'ETA - Drive status word',
    category: VfdParameterCategory.STATUS,
    registerAddress: 3201, // ETA
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Ready', description: 'Ready to switch on' },
      { bit: 1, name: 'On', description: 'Switched on' },
      { bit: 2, name: 'Running', description: 'Operation enabled' },
      { bit: 3, name: 'Fault', description: 'Fault present' },
      { bit: 4, name: 'Voltage Enabled', description: 'Voltage enabled' },
      { bit: 5, name: 'Quick Stop', description: 'Quick stop not active' },
      { bit: 6, name: 'Switch On Disabled', description: 'Switch on disabled' },
      { bit: 7, name: 'Warning', description: 'Warning active' },
      { bit: 8, name: 'Reserved', description: 'Reserved' },
      { bit: 9, name: 'Remote', description: 'Remote control' },
      { bit: 10, name: 'Reference Reached', description: 'Target reached' },
      { bit: 11, name: 'Internal Limit', description: 'Internal limit active' },
      { bit: 12, name: 'Reserved', description: 'Reserved' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'DC Bus Charged', description: 'DC bus charged' },
      { bit: 15, name: 'Direction', description: 'Reverse direction' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'drive_state',
    displayName: 'Drive State',
    description: 'HMIS - Drive state machine state',
    category: VfdParameterCategory.STATUS,
    registerAddress: 3202, // HMIS
    dataType: VfdDataType.UINT16,
    displayOrder: 2,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'RFR - Applied motor frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 8602, // RFR
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: -500,
    maxValue: 500,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'RFRD - Motor speed in RPM',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 8604, // SPD
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
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'LCR - Motor current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3204, // LCR
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'A',
    displayOrder: 12,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 2000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'motor_voltage',
    displayName: 'Motor Voltage',
    description: 'UOP - Motor voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3208, // UOP
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 13,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'OTR - Motor torque percentage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3205, // OTR
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 14,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'UDC - DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3209, // UDC
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: 'V',
    displayOrder: 15,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'OPR - Output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3206, // OPR
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
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'mains_voltage',
    displayName: 'Mains Voltage',
    description: 'ULN - Line voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 3210, // ULN
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: 'V',
    displayOrder: 17,
    recommendedPollIntervalMs: 2000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'frequency_reference',
    displayName: 'Frequency Reference',
    description: 'FRH - Frequency reference',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 8603, // FRH
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    displayOrder: 18,
    recommendedPollIntervalMs: 500,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'drive_thermal',
    displayName: 'Drive Thermal State',
    description: 'THD - Drive thermal state',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 3207, // THD
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 30,
    isCritical: true,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal State',
    description: 'THR - Motor thermal state',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 3211, // THR
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'dbr_thermal',
    displayName: 'DB Resistor Thermal',
    description: 'THBD - Braking resistor thermal state',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 3212, // THBD
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 32,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'energy_consumption',
    displayName: 'Energy Consumption',
    description: 'Consumed energy counter',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 7133, // Energy counter
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'RTH - Motor run time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 7135, // RTH
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'PTH - Power on time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 7137, // PTH
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'start_count',
    displayName: 'Start Count',
    description: 'Number of motor starts',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 7139, // Start counter
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'last_fault',
    displayName: 'Last Fault',
    description: 'LFT - Last detected fault',
    category: VfdParameterCategory.FAULT,
    registerAddress: 7121, // LFT
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'current_fault',
    displayName: 'Current Fault',
    description: 'CFP - Current fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 7125, // CFP
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'alarm_group_1',
    displayName: 'Alarm Group 1',
    description: 'ALG1 - Alarm group 1 bitmap',
    category: VfdParameterCategory.FAULT,
    registerAddress: 7130, // ALG1
    dataType: VfdDataType.UINT16,
    isBitField: true,
    displayOrder: 52,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'CMD - Control word',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 8501, // CMD
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Switch On', description: 'Switch on' },
      { bit: 1, name: 'Voltage Enable', description: 'Disable voltage' },
      { bit: 2, name: 'Quick Stop', description: 'Quick stop' },
      { bit: 3, name: 'Enable Operation', description: 'Enable operation' },
      { bit: 4, name: 'Bit 4', description: 'Operation mode specific' },
      { bit: 5, name: 'Bit 5', description: 'Operation mode specific' },
      { bit: 6, name: 'Bit 6', description: 'Operation mode specific' },
      { bit: 7, name: 'Fault Reset', description: 'Fault reset' },
      { bit: 8, name: 'Halt', description: 'Halt' },
      { bit: 9, name: 'Bit 9', description: 'Operation mode specific' },
      { bit: 10, name: 'Reserved', description: 'Reserved' },
      { bit: 11, name: 'Direction', description: 'Reverse direction' },
      { bit: 12, name: 'Reserved', description: 'Reserved' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'Reserved', description: 'Reserved' },
      { bit: 15, name: 'Reserved', description: 'Reserved' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.SCHNEIDER,
    parameterName: 'speed_reference_cmd',
    displayName: 'Speed Reference',
    description: 'LFRD - Frequency reference from fieldbus',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 8502, // LFRD
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: -500,
    maxValue: 500,
  },
];

/**
 * Schneider specific control word values (CiA402)
 */
export const SCHNEIDER_CONTROL_COMMANDS = {
  SHUTDOWN: 0x0006,         // Ready to switch on
  SWITCH_ON: 0x0007,        // Switched on
  ENABLE_OPERATION: 0x000f, // Operation enabled
  DISABLE_VOLTAGE: 0x0000,  // Disable voltage
  QUICK_STOP: 0x0002,       // Quick stop
  DISABLE_OPERATION: 0x0007,// Disable operation
  FAULT_RESET: 0x0080,      // Reset fault
  RUN_FORWARD: 0x000f,      // Run forward
  RUN_REVERSE: 0x080f,      // Run reverse
};

/**
 * Schneider default serial configuration
 */
export const SCHNEIDER_DEFAULT_CONFIG = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'even' as const,
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};
