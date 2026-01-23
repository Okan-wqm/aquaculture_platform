import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType } from '../entities/vfd.enums';

/**
 * Delta VFD Register Mappings
 * Supports: VFD-E, VFD-C, VFD-EL, VFD-M, VFD-S, MS300, MH300, C2000, CP2000
 *
 * Register Structure: Parameter group × 256 + parameter number
 * Example: P00.00 = 0x0000, P01.00 = 0x0100, P02.01 = 0x0201
 */
export const DELTA_VFD_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.DELTA,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status register',
    category: VfdParameterCategory.STATUS,
    registerAddress: 0x2100, // Status word address
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Drive Enabled', description: 'Drive operation enabled' },
      { bit: 1, name: 'Running', description: 'Motor running' },
      { bit: 2, name: 'Jog', description: 'Jog mode active' },
      { bit: 3, name: 'Forward', description: 'Forward direction' },
      { bit: 4, name: 'Reverse', description: 'Reverse direction' },
      { bit: 5, name: 'Ready', description: 'Drive ready' },
      { bit: 6, name: 'Fault', description: 'Fault active' },
      { bit: 7, name: 'Warning', description: 'Warning active' },
      { bit: 8, name: 'At Speed', description: 'At reference speed' },
      { bit: 9, name: 'Output High', description: 'Output above threshold' },
      { bit: 10, name: 'Output Low', description: 'Output below threshold' },
      { bit: 11, name: 'Overload', description: 'Overload condition' },
      { bit: 12, name: 'Limit Active', description: 'Limit active' },
      { bit: 13, name: 'DC Bus OK', description: 'DC bus voltage OK' },
      { bit: 14, name: 'Sleep', description: 'Sleep mode' },
      { bit: 15, name: 'Copy Complete', description: 'Parameter copy complete' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.DELTA,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual output frequency (H)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2103, // Output frequency
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 600,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Actual output current (A)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2104, // Output current
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'A',
    displayOrder: 11,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 1500,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Actual motor speed (RPM)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x210c, // Motor speed
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
    brand: VfdBrand.DELTA,
    parameterName: 'output_voltage',
    displayName: 'Output Voltage',
    description: 'Actual output voltage (V)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2106, // Output voltage
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 13,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage (V)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2105, // DC bus voltage
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Actual output power (kW)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x210d, // Output power
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
    brand: VfdBrand.DELTA,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Estimated motor torque (%)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x210e, // Motor torque
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 16,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'frequency_command',
    displayName: 'Frequency Command',
    description: 'Frequency reference (F)',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2101, // Frequency command
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 17,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 600,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'power_factor',
    displayName: 'Power Factor',
    description: 'Motor power factor',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 0x2107, // Power factor
    dataType: VfdDataType.INT16,
    scalingFactor: 0.001,
    displayOrder: 18,
    recommendedPollIntervalMs: 2000,
    minValue: -1,
    maxValue: 1,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.DELTA,
    parameterName: 'igbt_temp',
    displayName: 'IGBT Temperature',
    description: 'Power module temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x2108, // IGBT temperature
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
    brand: VfdBrand.DELTA,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal',
    description: 'Electronic thermal overload (OL)',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x2109, // Motor thermal
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'drive_thermal',
    displayName: 'Drive Thermal',
    description: 'Inverter thermal state',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 0x210a, // Drive thermal
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
    brand: VfdBrand.DELTA,
    parameterName: 'kwh_counter_low',
    displayName: 'Energy Counter Low',
    description: 'kWh counter low word',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x211a, // kWh low
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'kwh_counter_high',
    displayName: 'Energy Counter High',
    description: 'kWh counter high word',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x211b, // kWh high
    dataType: VfdDataType.UINT16,
    scalingFactor: 65536,
    unit: 'kWh',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'Total motor run time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2118, // Run hours
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'Total power on time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 0x2116, // Power on hours
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.DELTA,
    parameterName: 'fault_code',
    displayName: 'Fault Code',
    description: 'Current fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x2102, // Fault code
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'fault_record_1',
    displayName: 'Fault Record 1',
    description: 'Previous fault 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x0600, // Pr 06-00
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    recommendedPollIntervalMs: 5000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'fault_record_2',
    displayName: 'Fault Record 2',
    description: 'Previous fault 2',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x0601, // Pr 06-01
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    recommendedPollIntervalMs: 5000,
  },
  {
    brand: VfdBrand.DELTA,
    parameterName: 'warning_code',
    displayName: 'Warning Code',
    description: 'Current warning',
    category: VfdParameterCategory.FAULT,
    registerAddress: 0x210b, // Warning code
    dataType: VfdDataType.UINT16,
    displayOrder: 53,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.DELTA,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'Control command register',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x2000, // Control word
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Run/Stop', description: 'Run command (1=run)' },
      { bit: 1, name: 'Direction', description: 'Direction (0=FWD, 1=REV)' },
      { bit: 2, name: 'Jog', description: 'Jog command' },
      { bit: 3, name: 'Fault Reset', description: 'Fault reset' },
      { bit: 4, name: 'EF Input', description: 'External fault' },
      { bit: 5, name: 'Multi-speed 1', description: 'Multi-speed bit 1' },
      { bit: 6, name: 'Multi-speed 2', description: 'Multi-speed bit 2' },
      { bit: 7, name: 'Multi-speed 3', description: 'Multi-speed bit 3' },
      { bit: 8, name: 'Multi-speed 4', description: 'Multi-speed bit 4' },
      { bit: 9, name: 'Accel/Decel', description: 'Accel/Decel select' },
      { bit: 10, name: 'Second Source', description: 'Second frequency source' },
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
    brand: VfdBrand.DELTA,
    parameterName: 'frequency_ref',
    displayName: 'Frequency Reference',
    description: 'Frequency command via Modbus',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 0x2001, // Frequency reference
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: 0,
    maxValue: 600,
  },
];

/**
 * Delta specific control word values
 */
export const DELTA_CONTROL_COMMANDS = {
  STOP: 0x0000,
  RUN_FORWARD: 0x0001,
  RUN_REVERSE: 0x0003,
  JOG_FORWARD: 0x0005,
  JOG_REVERSE: 0x0007,
  FAULT_RESET: 0x0008,
};

/**
 * Delta default serial configuration
 */
export const DELTA_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 1,
  timeout: 500,
  retryCount: 3,
};

/**
 * Delta fault code definitions
 */
export const DELTA_FAULT_CODES: Record<number, string> = {
  0: 'No Fault',
  1: 'Over-current during acceleration (ocA)',
  2: 'Over-current during deceleration (ocd)',
  3: 'Over-current at constant speed (ocn)',
  4: 'Ground fault (GFF)',
  5: 'Over-voltage (ov)',
  6: 'Low voltage (Lv)',
  7: 'Motor overload (oL1)',
  8: 'Inverter overload (oL2)',
  9: 'Over-heat (oH1)',
  10: 'Over-heat (oH2)',
  11: 'PID feedback loss (AFE)',
  12: 'External fault (EF)',
  13: 'Communication error (CE)',
  14: 'Auto-tuning error (cF3)',
  15: 'IGBT short circuit (SoC)',
  16: 'Start overload (STo)',
  17: 'Software error (cod)',
  18: 'EEPROM error (cF1)',
  19: 'Hardware error (cF2)',
  20: 'Output phase loss (HPF)',
  21: 'Braking transistor fault (OPL)',
  22: 'Over-torque 1 (ot1)',
  23: 'Over-torque 2 (ot2)',
  24: 'Under-current (UC)',
};
