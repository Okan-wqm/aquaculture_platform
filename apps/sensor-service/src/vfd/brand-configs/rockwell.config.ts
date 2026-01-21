import { VfdRegisterMappingInput } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdParameterCategory, VfdDataType } from '../entities/vfd.enums';

/**
 * Rockwell Automation (Allen-Bradley) PowerFlex Register Mappings
 * Supports: PowerFlex 4, 40, 400, 525, 527, 700, 753, 755
 *
 * Register Structure: Parameters numbered by group
 * PowerFlex 525/527 use EtherNet/IP with explicit messaging or Modbus TCP/RTU
 */
export const ROCKWELL_POWERFLEX_REGISTERS: VfdRegisterMappingInput[] = [
  // ============ STATUS PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'status_word',
    displayName: 'Status Word',
    description: 'Drive status bits',
    category: VfdParameterCategory.STATUS,
    registerAddress: 40100, // Status word 1
    dataType: VfdDataType.STATUS_WORD,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Ready', description: 'Drive ready' },
      { bit: 1, name: 'Active', description: 'Drive active' },
      { bit: 2, name: 'Direction', description: 'Command direction' },
      { bit: 3, name: 'Motor Running', description: 'Motor rotating' },
      { bit: 4, name: 'Accelerating', description: 'Accelerating' },
      { bit: 5, name: 'Decelerating', description: 'Decelerating' },
      { bit: 6, name: 'Alarm', description: 'Alarm active' },
      { bit: 7, name: 'Faulted', description: 'Fault active' },
      { bit: 8, name: 'At Reference', description: 'At speed reference' },
      { bit: 9, name: 'Reference Exceeded', description: 'Above reference' },
      { bit: 10, name: 'Load Limit', description: 'Torque limit active' },
      { bit: 11, name: 'Power Limit', description: 'Power limit active' },
      { bit: 12, name: 'DC Bus Reg', description: 'Bus regulation active' },
      { bit: 13, name: 'Dynamic Brake', description: 'DB active' },
      { bit: 14, name: 'Forward', description: 'Forward rotation' },
      { bit: 15, name: 'Reverse', description: 'Reverse rotation' },
    ],
    displayOrder: 1,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'drive_status',
    displayName: 'Drive Status',
    description: 'Detailed drive status',
    category: VfdParameterCategory.STATUS,
    registerAddress: 40101, // Drive status
    dataType: VfdDataType.UINT16,
    displayOrder: 2,
    isCritical: true,
    recommendedPollIntervalMs: 200,
  },

  // ============ MOTOR PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'output_frequency',
    displayName: 'Output Frequency',
    description: 'Actual output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40001, // P001 Output Frequency
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 10,
    isCritical: true,
    recommendedPollIntervalMs: 500,
    minValue: 0,
    maxValue: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'motor_current',
    displayName: 'Motor Current',
    description: 'Output current',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40003, // P003 Output Current
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
    brand: VfdBrand.ROCKWELL,
    parameterName: 'motor_speed',
    displayName: 'Motor Speed',
    description: 'Motor speed in RPM',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40002, // P002 Motor Speed
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
    brand: VfdBrand.ROCKWELL,
    parameterName: 'output_voltage',
    displayName: 'Output Voltage',
    description: 'Output voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40004, // P004 Output Voltage
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 13,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1000,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'dc_bus_voltage',
    displayName: 'DC Bus Voltage',
    description: 'DC link voltage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40005, // P005 DC Bus Voltage
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: 'V',
    displayOrder: 14,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 1200,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'output_power',
    displayName: 'Output Power',
    description: 'Output power',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40006, // P006 Output Power
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
    brand: VfdBrand.ROCKWELL,
    parameterName: 'motor_torque',
    displayName: 'Motor Torque',
    description: 'Output torque percentage',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40007, // P007 Motor Torque
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 16,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'commanded_frequency',
    displayName: 'Commanded Frequency',
    description: 'Commanded output frequency',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40008, // P008 Commanded Freq
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    displayOrder: 17,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'analog_input',
    displayName: 'Analog Input',
    description: 'Analog input value',
    category: VfdParameterCategory.MOTOR,
    registerAddress: 40009, // P009 Analog Input
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 18,
    recommendedPollIntervalMs: 1000,
    minValue: 0,
    maxValue: 100,
  },

  // ============ THERMAL PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'heatsink_temp',
    displayName: 'Heatsink Temperature',
    description: 'Power module temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40010, // P010 Heatsink Temp
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 30,
    isCritical: true,
    recommendedPollIntervalMs: 5000,
    minValue: -40,
    maxValue: 150,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'drive_thermal',
    displayName: 'Drive Thermal',
    description: 'Drive thermal utilization',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40011, // P011 Drive Thermal
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 31,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'motor_thermal',
    displayName: 'Motor Thermal',
    description: 'Motor thermal utilization',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40012, // P012 Motor Thermal
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.1,
    unit: '%',
    displayOrder: 32,
    recommendedPollIntervalMs: 5000,
    minValue: 0,
    maxValue: 200,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'control_board_temp',
    displayName: 'Control Board Temperature',
    description: 'Control board temperature',
    category: VfdParameterCategory.THERMAL,
    registerAddress: 40013, // P013 Control Temp
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '°C',
    displayOrder: 33,
    recommendedPollIntervalMs: 5000,
    minValue: -40,
    maxValue: 100,
  },

  // ============ ENERGY PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'kwh_accumulated',
    displayName: 'Energy Accumulated',
    description: 'Total energy consumption',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40400, // Energy counter
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'kWh',
    displayOrder: 40,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'run_time',
    displayName: 'Run Time',
    description: 'Total motor run time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40402, // Run time hours
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 41,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'power_up_time',
    displayName: 'Power Up Time',
    description: 'Total power up time',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40404, // Power on hours
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 0.1,
    unit: 'h',
    displayOrder: 42,
    recommendedPollIntervalMs: 60000,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'start_count',
    displayName: 'Start Count',
    description: 'Number of starts',
    category: VfdParameterCategory.ENERGY,
    registerAddress: 40406, // Start counter
    registerCount: 2,
    dataType: VfdDataType.UINT32,
    scalingFactor: 1,
    displayOrder: 43,
    recommendedPollIntervalMs: 60000,
  },

  // ============ FAULT PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'fault_code_1',
    displayName: 'Fault Code 1',
    description: 'Current fault 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40201, // Fault code 1
    dataType: VfdDataType.UINT16,
    displayOrder: 50,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'fault_code_2',
    displayName: 'Fault Code 2',
    description: 'Current fault 2',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40202, // Fault code 2
    dataType: VfdDataType.UINT16,
    displayOrder: 51,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'alarm_code_1',
    displayName: 'Alarm Code 1',
    description: 'Current alarm 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40203, // Alarm code 1
    dataType: VfdDataType.UINT16,
    displayOrder: 52,
    isCritical: true,
    recommendedPollIntervalMs: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'fault_history_1',
    displayName: 'Fault History 1',
    description: 'Previous fault 1',
    category: VfdParameterCategory.FAULT,
    registerAddress: 40204, // Fault history 1
    dataType: VfdDataType.UINT16,
    displayOrder: 53,
    recommendedPollIntervalMs: 5000,
  },

  // ============ CONTROL PARAMETERS ============
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'control_word',
    displayName: 'Control Word',
    description: 'Logic command word',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 40300, // Logic command
    dataType: VfdDataType.CONTROL_WORD,
    isWritable: true,
    isBitField: true,
    bitDefinitions: [
      { bit: 0, name: 'Stop', description: 'Stop command (0=stop)' },
      { bit: 1, name: 'Start', description: 'Start command' },
      { bit: 2, name: 'Jog', description: 'Jog command' },
      { bit: 3, name: 'Clear Faults', description: 'Fault reset' },
      { bit: 4, name: 'Speed Ref Sel', description: 'Speed reference select' },
      { bit: 5, name: 'Local Control', description: 'Local control' },
      { bit: 6, name: 'Direction', description: 'Forward/Reverse' },
      { bit: 7, name: 'Accel/Decel', description: 'Accel/Decel select' },
      { bit: 8, name: 'MOP Inc', description: 'Motor pot increment' },
      { bit: 9, name: 'MOP Dec', description: 'Motor pot decrement' },
      { bit: 10, name: 'Preset Speed 1', description: 'Preset speed bit 0' },
      { bit: 11, name: 'Preset Speed 2', description: 'Preset speed bit 1' },
      { bit: 12, name: 'Preset Speed 3', description: 'Preset speed bit 2' },
      { bit: 13, name: 'PI Enable', description: 'PI loop enable' },
      { bit: 14, name: 'PI Reset', description: 'PI loop reset' },
      { bit: 15, name: 'Reserved', description: 'Reserved' },
    ],
    displayOrder: 60,
    recommendedPollIntervalMs: 200,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'speed_reference',
    displayName: 'Speed Reference',
    description: 'Speed reference via network',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 40301, // Reference word
    dataType: VfdDataType.INT16,
    scalingFactor: 0.01,
    unit: 'Hz',
    isWritable: true,
    displayOrder: 61,
    recommendedPollIntervalMs: 200,
    minValue: -500,
    maxValue: 500,
  },
  {
    brand: VfdBrand.ROCKWELL,
    parameterName: 'torque_reference',
    displayName: 'Torque Reference',
    description: 'Torque reference',
    category: VfdParameterCategory.CONTROL,
    registerAddress: 40302, // Torque reference
    dataType: VfdDataType.INT16,
    scalingFactor: 0.1,
    unit: '%',
    isWritable: true,
    displayOrder: 62,
    recommendedPollIntervalMs: 500,
    minValue: -300,
    maxValue: 300,
  },
];

/**
 * Rockwell specific control word values
 */
export const ROCKWELL_CONTROL_COMMANDS = {
  STOP: 0x0000,
  START_FORWARD: 0x0002,
  START_REVERSE: 0x0042,
  JOG_FORWARD: 0x0006,
  JOG_REVERSE: 0x0046,
  CLEAR_FAULTS: 0x0008,
  MOP_INCREMENT: 0x0102,
  MOP_DECREMENT: 0x0202,
};

/**
 * Rockwell default serial configuration (for Modbus RTU)
 */
export const ROCKWELL_DEFAULT_CONFIG = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'none' as const,
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};

/**
 * PowerFlex fault code definitions (common codes)
 */
export const ROCKWELL_FAULT_CODES: Record<number, string> = {
  0: 'No Fault',
  2: 'Auxiliary Input',
  3: 'Power Loss',
  4: 'UnderVoltage',
  5: 'OverVoltage',
  6: 'Motor Stall',
  7: 'Motor Overload',
  8: 'Heatsink OvrTmp',
  12: 'HW OverCurrent',
  13: 'Ground Fault',
  29: 'Analog In Loss',
  33: 'Auto Rstrt Tries',
  38: 'Phase U to Gnd',
  39: 'Phase V to Gnd',
  40: 'Phase W to Gnd',
  41: 'Phase UV Short',
  42: 'Phase UW Short',
  43: 'Phase VW Short',
  48: 'Params Defaulted',
  63: 'SW OverCurrent',
  64: 'Drive Overload',
  70: 'Power Unit',
  80: 'Net Loss',
  81: 'Port 5 DPI Loss',
  82: 'Port 6 DSI Loss',
  100: 'Parameter Checksum',
  122: 'I/O Board Fail',
  125: 'Slot1 Comm Loss',
  126: 'Slot2 Comm Loss',
};

/**
 * PowerFlex models and their specific features
 */
export const ROCKWELL_MODELS = {
  POWERFLEX_4: {
    name: 'PowerFlex 4',
    maxPower: 3.7,
    protocols: ['MODBUS_RTU'],
  },
  POWERFLEX_40: {
    name: 'PowerFlex 40',
    maxPower: 11,
    protocols: ['MODBUS_RTU', 'DEVICENET'],
  },
  POWERFLEX_525: {
    name: 'PowerFlex 525',
    maxPower: 22,
    protocols: ['MODBUS_RTU', 'MODBUS_TCP', 'ETHERNET_IP'],
  },
  POWERFLEX_527: {
    name: 'PowerFlex 527',
    maxPower: 22,
    protocols: ['ETHERNET_IP'],
  },
  POWERFLEX_755: {
    name: 'PowerFlex 755',
    maxPower: 2300,
    protocols: ['MODBUS_TCP', 'ETHERNET_IP', 'CONTROLNET', 'DEVICENET'],
  },
};
