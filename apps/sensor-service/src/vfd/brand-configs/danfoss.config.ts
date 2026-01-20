import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from '../entities/vfd.enums';
import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';

/**
 * Danfoss FC Series Register Mappings
 * Supports: FC102, FC302, FC51, VLT 2800, VLT 5000, VLT 6000, VLT HVAC
 *
 * Register Calculation: Register = (Parameter No × 10) - 1
 * Example: Parameter 16-13 (Output Frequency) = (1613 × 10) - 1 = 16129
 */
export const DANFOSS_FC_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status bits',
    category: VfdParameterCategory.STATUS,
    registerAddress: 16029, // 16-03
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Control Ready', description: 'Drive ready for control' },
      { bit: 1, name: 'Drive Ready', description: 'Drive ready to run' },
      { bit: 2, name: 'Coasting', description: 'Drive is coasting' },
      { bit: 3, name: 'Trip', description: 'Drive has tripped' },
      { bit: 4, name: 'Trip Lock', description: 'Trip lock active' },
      { bit: 5, name: 'Reserved', description: 'Reserved bit' },
      { bit: 6, name: 'Trip Lock', description: 'Trip lock active' },
      { bit: 7, name: 'Warning', description: 'Warning active' },
      { bit: 8, name: 'At Reference', description: 'Speed at reference' },
      { bit: 9, name: 'Auto Mode', description: 'Automatic mode' },
      { bit: 10, name: 'Out of Freq Range', description: 'Output frequency out of range' },
      { bit: 11, name: 'Running', description: 'Motor running' },
      { bit: 12, name: 'Voltage Warning', description: 'DC bus voltage warning' },
      { bit: 13, name: 'Current Limit', description: 'Current limit active' },
      { bit: 14, name: 'Thermal Warning', description: 'Thermal warning' },
      { bit: 15, name: 'Reserved', description: 'Reserved bit' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual motor frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16129, // 16-13
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 400,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Actual motor current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16139, // 16-14
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.01,
    unit: 'A',
    displayOrder: 11,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'motor_voltage',
    displayName: 'Motor Voltage',
    description: 'Actual motor voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16119, // 16-12
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 12,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Actual motor speed in RPM',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16169, // 16-17
    registerCount: 2,
    dataType: VfdDataType.INT32,
    scalingFactor: 1,
    unit: 'RPM',
    displayOrder: 13,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 6000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Actual motor torque as percentage of nominal',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16159, // 16-16
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 14,
    recommendedPollIntervalMs: 500,
    minValue: -200,
    maxValue: 200,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Actual output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16099, // 16-10
    registerCount: 2,
    dataType: VfdDataType.INT32,
    scalingFactor: 0.1,
    unit: 'kW',
    displayOrder: 15,
    isCritical: true,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16299, // 16-30
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 16,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'power_factor',
    displayName: 'Power Factor',
    description: 'Actual power factor',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16109, // 16-11
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    displayOrder: 17,
    recommendedPollIntervalMs: 2000,
    minValue: 0,
    maxValue: 1,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'speed_reference',
    displayName: 'Speed Reference',
    description: 'Active speed reference',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 16019, // 16-02
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    displayOrder: 18,
    recommendedPollIntervalMs: 500,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'heatsink_temp',
    displayName: 'Heatsink Temperature',
    description: 'Drive heatsink temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 16339, // 16-34
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
    brand: VfdBrand.DANFOSS,
    parameterName: 'control_card_temp',
    displayName: 'Control Card Temperature',
    description: 'Control card temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 16349, // 16-35
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: -20,
    maxValue: 85,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal',
    description: 'Calculated motor thermal status',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 16329, // 16-33
    dataType: VfdDataType.UINT16,
    scalingFactor: 1,
    unit: '%',
    displayOrder: 32,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 100,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'running_hours',
    displayName: 'Running Hours',
    description: 'Total motor running hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 14999, // 15-00
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'power_on_hours',
    displayName: 'Power On Hours',
    description: 'Total drive power on hours',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 15009, // 15-01
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'energy_consumption',
    displayName: 'Energy Consumption',
    description: 'Total energy consumption',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 15019, // 15-02
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    unit: 'kWh',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'start_count',
    displayName: 'Start Count',
    description: 'Total number of starts',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 15029, // 15-03
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'alarm_word',
    displayName: 'Alarm Word',
    description: 'Active alarms bitmap',
    category: VfdParameterCategory.FAULT,
    registerAddress: 16899, // 16-90
    dataType: VfdDataType.UINT16,
    isBitField: true,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'warning_word',
    displayName: 'Warning Word',
    description: 'Active warnings bitmap',
    category: VfdParameterCategory.FAULT,
    registerAddress: 16919, // 16-92
    dataType: VfdDataType.UINT16,
    isBitField: true,
    displayOrder: 51,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'fault_code',
    displayName: 'Fault Code',
    description: 'Last fault code',
    category: VfdParameterCategory.FAULT,
    registerAddress: 15939, // 15-94
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'Control word for drive commands',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 49999, // 50-00 (STW)
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Reference Select', description: 'Reference selection bit 0' },
      { bit: 1, name: 'Reference Select', description: 'Reference selection bit 1' },
      { bit: 2, name: 'DC Brake', description: 'DC brake command' },
      { bit: 3, name: 'Coasting', description: 'Coasting stop' },
      { bit: 4, name: 'Quick Stop', description: 'Quick stop command' },
      { bit: 5, name: 'Freeze Frequency', description: 'Freeze output frequency' },
      { bit: 6, name: 'Ramp Stop', description: 'Ramp stop command' },
      { bit: 7, name: 'Reset', description: 'Reset fault' },
      { bit: 8, name: 'Jog', description: 'Jog mode' },
      { bit: 9, name: 'Ramp', description: 'Ramp selection' },
      { bit: 10, name: 'Data Valid', description: 'Data valid' },
      { bit: 11, name: 'Relay', description: 'Relay output control' },
      { bit: 12, name: 'Reserved', description: 'Reserved' },
      { bit: 13, name: 'Reserved', description: 'Reserved' },
      { bit: 14, name: 'Reserved', description: 'Reserved' },
      { bit: 15, name: 'Reverse', description: 'Reverse direction' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'frequency_reference',
    displayName: 'Frequency Reference',
    description: 'Bus reference for frequency setpoint',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 50009, // 50-01 (REF)
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: 0,
    maxValue: 400,
  },
];

/**
 * Danfoss specific control word values
 */
export const DANFOSS_CONTROL_COMMANDS = {
  START: 0x047f,    // Start with ramp
  STOP: 0x043c,     // Stop with ramp
  COAST: 0x0437,    // Coast stop
  QUICK_STOP: 0x042f, // Quick stop
  RESET: 0x04ff,    // Fault reset
  JOG: 0x057f,      // Jog mode
};

/**
 * Danfoss default serial configuration
 */
export const DANFOSS_DEFAULT_CONFIG = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};
