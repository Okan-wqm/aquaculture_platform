/**
 * VFD (Variable Frequency Drive) TypeScript Types
 *
 * Comprehensive type definitions for VFD device management including:
 * - 8 major brands: Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta, Mitsubishi, Rockwell
 * - 7+ protocols: Modbus RTU/TCP, PROFIBUS DP, PROFINET, EtherNet/IP, CANopen, BACnet
 * - 50+ parameters per device
 * - Control Word/Status Word operations
 */

// ============ ENUMS ============

export enum VfdBrand {
  DANFOSS = 'danfoss',
  ABB = 'abb',
  SIEMENS = 'siemens',
  SCHNEIDER = 'schneider',
  YASKAWA = 'yaskawa',
  DELTA = 'delta',
  MITSUBISHI = 'mitsubishi',
  ROCKWELL = 'rockwell',
}

export enum VfdProtocol {
  MODBUS_RTU = 'modbus_rtu',
  MODBUS_TCP = 'modbus_tcp',
  PROFIBUS_DP = 'profibus_dp',
  PROFINET = 'profinet',
  ETHERNET_IP = 'ethernet_ip',
  CANOPEN = 'canopen',
  BACNET_IP = 'bacnet_ip',
  BACNET_MSTP = 'bacnet_mstp',
}

export enum VfdParameterCategory {
  STATUS = 'status',
  MOTOR = 'motor',
  ENERGY = 'energy',
  THERMAL = 'thermal',
  FAULT = 'fault',
  CONTROL = 'control',
  REFERENCE = 'reference',
  PID = 'pid',
  COMMUNICATION = 'communication',
}

export enum VfdDeviceStatus {
  DRAFT = 'draft',
  PENDING_TEST = 'pending_test',
  TESTING = 'testing',
  TEST_FAILED = 'test_failed',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance',
  FAULT = 'fault',
}

export enum VfdCommandType {
  START = 'start',
  STOP = 'stop',
  REVERSE = 'reverse',
  SET_FREQUENCY = 'set_frequency',
  SET_SPEED = 'set_speed',
  FAULT_RESET = 'fault_reset',
  EMERGENCY_STOP = 'emergency_stop',
  JOG_FORWARD = 'jog_forward',
  JOG_REVERSE = 'jog_reverse',
  COAST_STOP = 'coast_stop',
  QUICK_STOP = 'quick_stop',
}

export enum VfdDataType {
  UINT16 = 'uint16',
  INT16 = 'int16',
  UINT32 = 'uint32',
  INT32 = 'int32',
  FLOAT32 = 'float32',
  BOOLEAN = 'boolean',
  STRING = 'string',
}

export enum ByteOrder {
  BIG = 'big',
  LITTLE = 'little',
}

// ============ BRAND INFO ============

export interface VfdBrandInfo {
  code: VfdBrand;
  name: string;
  logo?: string;
  description: string;
  supportedProtocols: VfdProtocol[];
  modelSeries: VfdModelSeries[];
  defaultSerialConfig: ModbusRtuConfig;
  website?: string;
}

export interface VfdModelSeries {
  code: string;
  name: string;
  description?: string;
  powerRange?: string;
  features?: string[];
}

// ============ PROTOCOL CONFIGURATIONS ============

export interface ModbusRtuConfig {
  serialPort: string;
  slaveId: number;
  baudRate: 4800 | 9600 | 19200 | 38400 | 57600 | 115200;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  timeout: number;
  retryCount: number;
  interFrameDelay?: number;
}

export interface ModbusTcpConfig {
  host: string;
  port: number;
  unitId: number;
  connectionTimeout: number;
  responseTimeout: number;
  keepAlive?: boolean;
  reconnectInterval?: number;
}

export interface ProfibusDpConfig {
  stationAddress: number;
  baudRate: 9600 | 19200 | 45450 | 93750 | 187500 | 500000 | 1500000 | 3000000 | 6000000 | 12000000;
  masterAddress: number;
  gsdFile?: string;
  inputOffset?: number;
  outputOffset?: number;
  parameterData?: string;
}

export interface ProfinetConfig {
  deviceName: string;
  ipAddress: string;
  subnetMask: string;
  gateway?: string;
  gsdmlFile?: string;
  arData?: {
    inputSlot: number;
    inputSubslot: number;
    outputSlot: number;
    outputSubslot: number;
  };
  updateRate?: number;
  watchdogTime?: number;
}

export interface EthernetIpConfig {
  host: string;
  port: number;
  vendorId?: number;
  deviceType?: number;
  productCode?: number;
  edsFile?: string;
  assemblyInstance: {
    input: number;
    output: number;
    config?: number;
  };
  rpi?: number;
  connectionType?: 'exclusive' | 'inputOnly' | 'listenOnly';
}

export interface CanopenConfig {
  nodeId: number;
  baudRate: 10000 | 20000 | 50000 | 125000 | 250000 | 500000 | 800000 | 1000000;
  interface: string;
  edsFile?: string;
  heartbeatProducerTime?: number;
  heartbeatConsumerTime?: number;
  pdoMapping?: PdoMapping[];
  sdoTimeout?: number;
}

export interface PdoMapping {
  pdoIndex: number;
  direction: 'rx' | 'tx';
  cobId: number;
  entries: PdoEntry[];
}

export interface PdoEntry {
  index: number;
  subindex: number;
  bitLength: number;
}

export interface BacnetIpConfig {
  ipAddress: string;
  port: number;
  deviceInstance: number;
  networkNumber?: number;
  maxApduLength?: number;
  segmentationSupported?: boolean;
  vendorId?: number;
  objects?: BacnetObject[];
}

export interface BacnetMstpConfig {
  serialPort: string;
  baudRate: 9600 | 19200 | 38400 | 57600 | 76800 | 115200;
  macAddress: number;
  maxMaster: number;
  maxInfoFrames?: number;
  deviceInstance: number;
  objects?: BacnetObject[];
}

export interface BacnetObject {
  objectType: 'analogInput' | 'analogOutput' | 'analogValue' | 'binaryInput' | 'binaryOutput' | 'binaryValue';
  objectInstance: number;
  propertyId: string;
  parameterName: string;
}

export type VfdProtocolConfiguration =
  | ModbusRtuConfig
  | ModbusTcpConfig
  | ProfibusDpConfig
  | ProfinetConfig
  | EthernetIpConfig
  | CanopenConfig
  | BacnetIpConfig
  | BacnetMstpConfig;

// ============ REGISTER MAPPING ============

export interface VfdRegisterMapping {
  id: string;
  brand: VfdBrand;
  modelSeries?: string;
  parameterName: string;
  displayName: string;
  category: VfdParameterCategory;
  registerAddress: number;
  registerCount: number;
  functionCode: number;
  dataType: VfdDataType;
  scalingFactor: number;
  offset: number;
  unit?: string;
  byteOrder: ByteOrder;
  wordOrder: ByteOrder;
  isBitField: boolean;
  bitDefinitions?: Record<string, string>;
  isReadable: boolean;
  isWritable: boolean;
  pollIntervalMs: number;
  minValue?: number;
  maxValue?: number;
  description?: string;
  isActive: boolean;
}

// ============ VFD DEVICE ============

export interface VfdDevice {
  id: string;
  name: string;
  brand: VfdBrand;
  model?: string;
  modelSeries?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  protocol: VfdProtocol;
  protocolConfiguration: VfdProtocolConfiguration;
  connectionStatus: VfdConnectionStatus;
  status: VfdDeviceStatus;
  installationDate?: string;
  lastMaintenanceDate?: string;
  notes?: string;
  tags?: string[];
  tenantId: string;
  farmId?: string;
  tankId?: string;
  pumpId?: string;
  location?: string;
  createdAt: string;
  updatedAt: string;
  latestReading?: VfdReading;
}

export interface VfdConnectionStatus {
  isConnected: boolean;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  latencyMs?: number;
  reconnectAttempts?: number;
  connectionQuality?: 'excellent' | 'good' | 'fair' | 'poor';
}

// ============ VFD READINGS ============

export interface VfdReading {
  id: string;
  vfdDeviceId: string;
  tenantId: string;
  timestamp: string;
  parameters: VfdParameters;
  statusBits: VfdStatusBits;
  rawValues?: Record<string, number>;
  quality?: ReadingQuality;
}

export interface VfdParameters {
  // Motor parameters
  outputFrequency?: number;
  motorSpeed?: number;
  motorCurrent?: number;
  motorVoltage?: number;
  motorTorque?: number;
  motorPower?: number;

  // Electrical parameters
  dcBusVoltage?: number;
  outputPower?: number;
  inputPower?: number;
  powerFactor?: number;

  // Thermal parameters
  driveTemperature?: number;
  motorTemperature?: number;
  heatsinkTemperature?: number;
  ambientTemperature?: number;

  // Energy parameters
  energyConsumption?: number;
  runningHours?: number;
  powerOnHours?: number;

  // Reference & setpoint
  frequencySetpoint?: number;
  speedSetpoint?: number;
  torqueSetpoint?: number;

  // Status
  statusWord?: number;
  controlWord?: number;
  faultCode?: number;
  warningCode?: number;

  // Additional parameters
  [key: string]: number | undefined;
}

export interface VfdStatusBits {
  // Standard status bits
  ready: boolean;
  running: boolean;
  fault: boolean;
  warning: boolean;
  atSetpoint: boolean;
  atReference: boolean;

  // Direction
  direction: 'forward' | 'reverse' | 'stopped';

  // Operation modes
  remoteControl: boolean;
  localControl: boolean;
  autoMode: boolean;
  manualMode: boolean;

  // Limits
  currentLimit: boolean;
  voltageLimit: boolean;
  torqueLimit: boolean;
  speedLimit: boolean;

  // Additional bits
  enabled: boolean;
  quickStopActive: boolean;
  switchOnDisabled: boolean;

  // Custom bits
  [key: string]: boolean | string;
}

export interface ReadingQuality {
  overallQuality: 'good' | 'uncertain' | 'bad';
  communicationStatus: 'ok' | 'timeout' | 'error';
  dataValidity: 'valid' | 'stale' | 'invalid';
  timestamp: string;
}

// ============ VFD COMMANDS ============

export interface VfdCommand {
  command: VfdCommandType;
  value?: number;
  unit?: string;
  timestamp?: string;
}

export interface VfdCommandResult {
  success: boolean;
  command: VfdCommandType;
  acknowledgedAt?: string;
  executionTimeMs?: number;
  error?: string;
  previousValue?: number;
  newValue?: number;
}

// ============ CONNECTION TEST ============

export interface VfdConnectionTestInput {
  protocol: VfdProtocol;
  configuration: VfdProtocolConfiguration;
  brand?: VfdBrand;
  modelSeries?: string;
  timeout?: number;
}

export interface VfdConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  sampleData?: Partial<VfdParameters>;
  statusBits?: Partial<VfdStatusBits>;
  firmwareVersion?: string;
  deviceInfo?: {
    manufacturer?: string;
    model?: string;
    serialNumber?: string;
  };
  testedAt: string;
  diagnostics?: VfdDiagnostics;
}

export interface VfdDiagnostics {
  communicationErrors: number;
  retries: number;
  packetsSent: number;
  packetsReceived: number;
  averageLatency: number;
  maxLatency: number;
}

// ============ INPUTS ============

export interface RegisterVfdInput {
  name: string;
  brand: VfdBrand;
  model?: string;
  modelSeries?: string;
  serialNumber?: string;
  protocol: VfdProtocol;
  protocolConfiguration: VfdProtocolConfiguration;
  farmId?: string;
  tankId?: string;
  pumpId?: string;
  location?: string;
  notes?: string;
  tags?: string[];
  skipConnectionTest?: boolean;
}

export interface UpdateVfdInput {
  name?: string;
  model?: string;
  serialNumber?: string;
  protocolConfiguration?: VfdProtocolConfiguration;
  farmId?: string;
  tankId?: string;
  pumpId?: string;
  location?: string;
  notes?: string;
  tags?: string[];
}

export interface VfdCommandInput {
  command: VfdCommandType;
  value?: number;
}

// ============ RESULTS ============

export interface VfdRegistrationResult {
  success: boolean;
  vfdDevice?: VfdDevice;
  error?: string;
  connectionTestPassed?: boolean;
  latencyMs?: number;
}

// ============ FILTERS & PAGINATION ============

export interface VfdFilter {
  brand?: VfdBrand;
  protocol?: VfdProtocol;
  status?: VfdDeviceStatus;
  farmId?: string;
  tankId?: string;
  search?: string;
  isConnected?: boolean;
  hasFault?: boolean;
}

export interface VfdDeviceList {
  items: VfdDevice[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VfdReadingFilter {
  vfdDeviceId: string;
  from?: string;
  to?: string;
  parameters?: string[];
  limit?: number;
  offset?: number;
}

// ============ STATISTICS ============

export interface VfdStats {
  total: number;
  active: number;
  inactive: number;
  faulted: number;
  maintenance: number;
  byBrand: Record<VfdBrand, number>;
  byProtocol: Record<VfdProtocol, number>;
  byStatus: Record<VfdDeviceStatus, number>;
}

export interface VfdReadingStats {
  vfdDeviceId: string;
  period: 'hour' | 'day' | 'week' | 'month';
  avgFrequency: number;
  avgCurrent: number;
  avgPower: number;
  maxFrequency: number;
  maxCurrent: number;
  maxPower: number;
  totalEnergy: number;
  runningTime: number;
  faultCount: number;
}

// ============ WIZARD STATE ============

export interface VfdWizardStep {
  id: string;
  title: string;
  description?: string;
  isComplete: boolean;
  isActive: boolean;
  isOptional?: boolean;
}

export interface VfdRegistrationWizardState {
  currentStep: number;
  steps: VfdWizardStep[];
  selectedBrand?: VfdBrandInfo;
  selectedProtocol?: VfdProtocol;
  selectedModelSeries?: string;
  basicInfo: Partial<RegisterVfdInput>;
  protocolConfig: Partial<VfdProtocolConfiguration>;
  customRegisterMappings?: VfdRegisterMapping[];
  connectionTestResult?: VfdConnectionTestResult;
  isSubmitting: boolean;
  isTestingConnection: boolean;
  error?: string;
}

// ============ PROTOCOL SCHEMA ============

export interface VfdProtocolSchema {
  protocol: VfdProtocol;
  displayName: string;
  description: string;
  connectionType: 'serial' | 'ethernet' | 'fieldbus';
  configurationSchema: VfdConfigurationSchema;
  defaultConfiguration: VfdProtocolConfiguration;
  validationRules?: VfdValidationRule[];
}

export interface VfdConfigurationSchema {
  type: 'object';
  required: string[];
  properties: Record<string, VfdSchemaProperty>;
  'ui:groups'?: VfdUIGroup[];
}

export interface VfdSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  title: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
  enumNames?: string[];
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: string;
  items?: VfdSchemaProperty;
  'ui:order'?: number;
  'ui:group'?: string;
  'ui:widget'?: string;
  'ui:placeholder'?: string;
  'ui:help'?: string;
}

export interface VfdUIGroup {
  name: string;
  title: string;
  description?: string;
  fields: string[];
  collapsed?: boolean;
}

export interface VfdValidationRule {
  field: string;
  rule: 'required' | 'min' | 'max' | 'pattern' | 'custom';
  value?: unknown;
  message: string;
}

// ============ BRAND CONSTANTS ============

export const VFD_BRAND_NAMES: Record<VfdBrand, string> = {
  [VfdBrand.DANFOSS]: 'Danfoss',
  [VfdBrand.ABB]: 'ABB',
  [VfdBrand.SIEMENS]: 'Siemens',
  [VfdBrand.SCHNEIDER]: 'Schneider Electric',
  [VfdBrand.YASKAWA]: 'Yaskawa',
  [VfdBrand.DELTA]: 'Delta Electronics',
  [VfdBrand.MITSUBISHI]: 'Mitsubishi Electric',
  [VfdBrand.ROCKWELL]: 'Rockwell Automation',
};

export const VFD_BRAND_DESCRIPTIONS: Record<VfdBrand, string> = {
  [VfdBrand.DANFOSS]: 'VLT & VACON series drives for industrial and HVAC applications',
  [VfdBrand.ABB]: 'ACS series drives with advanced motor control technology',
  [VfdBrand.SIEMENS]: 'SINAMICS series for automation and drive technology',
  [VfdBrand.SCHNEIDER]: 'Altivar series for industrial and building automation',
  [VfdBrand.YASKAWA]: 'A1000/V1000 series with high-performance vector control',
  [VfdBrand.DELTA]: 'VFD series for industrial and HVAC applications',
  [VfdBrand.MITSUBISHI]: 'FR series with advanced sensorless vector control',
  [VfdBrand.ROCKWELL]: 'PowerFlex series for industrial automation',
};

export const VFD_PROTOCOL_NAMES: Record<VfdProtocol, string> = {
  [VfdProtocol.MODBUS_RTU]: 'Modbus RTU',
  [VfdProtocol.MODBUS_TCP]: 'Modbus TCP/IP',
  [VfdProtocol.PROFIBUS_DP]: 'PROFIBUS DP',
  [VfdProtocol.PROFINET]: 'PROFINET IO',
  [VfdProtocol.ETHERNET_IP]: 'EtherNet/IP',
  [VfdProtocol.CANOPEN]: 'CANopen',
  [VfdProtocol.BACNET_IP]: 'BACnet/IP',
  [VfdProtocol.BACNET_MSTP]: 'BACnet MS/TP',
};

export const VFD_PROTOCOL_DESCRIPTIONS: Record<VfdProtocol, string> = {
  [VfdProtocol.MODBUS_RTU]: 'Serial RS-485 communication with Modbus RTU protocol',
  [VfdProtocol.MODBUS_TCP]: 'Ethernet-based Modbus TCP/IP communication',
  [VfdProtocol.PROFIBUS_DP]: 'PROFIBUS Decentralized Periphery for factory automation',
  [VfdProtocol.PROFINET]: 'Industrial Ethernet standard for real-time communication',
  [VfdProtocol.ETHERNET_IP]: 'CIP-based industrial Ethernet protocol',
  [VfdProtocol.CANOPEN]: 'CAN-based higher layer protocol for embedded systems',
  [VfdProtocol.BACNET_IP]: 'Building automation protocol over IP',
  [VfdProtocol.BACNET_MSTP]: 'Building automation protocol over RS-485',
};

export const VFD_COMMAND_NAMES: Record<VfdCommandType, string> = {
  [VfdCommandType.START]: 'Start',
  [VfdCommandType.STOP]: 'Stop',
  [VfdCommandType.REVERSE]: 'Reverse Direction',
  [VfdCommandType.SET_FREQUENCY]: 'Set Frequency',
  [VfdCommandType.SET_SPEED]: 'Set Speed',
  [VfdCommandType.FAULT_RESET]: 'Reset Fault',
  [VfdCommandType.EMERGENCY_STOP]: 'Emergency Stop',
  [VfdCommandType.JOG_FORWARD]: 'Jog Forward',
  [VfdCommandType.JOG_REVERSE]: 'Jog Reverse',
  [VfdCommandType.COAST_STOP]: 'Coast Stop',
  [VfdCommandType.QUICK_STOP]: 'Quick Stop',
};

export const VFD_PARAMETER_UNITS: Record<string, string> = {
  outputFrequency: 'Hz',
  motorSpeed: 'RPM',
  motorCurrent: 'A',
  motorVoltage: 'V',
  motorTorque: '%',
  motorPower: 'kW',
  dcBusVoltage: 'V',
  outputPower: 'kW',
  inputPower: 'kW',
  driveTemperature: '°C',
  motorTemperature: '°C',
  heatsinkTemperature: '°C',
  energyConsumption: 'kWh',
  runningHours: 'h',
};

// ============ BRAND MODEL SERIES ============

export const VFD_MODEL_SERIES: Record<VfdBrand, VfdModelSeries[]> = {
  [VfdBrand.DANFOSS]: [
    { code: 'FC102', name: 'VLT HVAC Basic Drive FC 102', powerRange: '0.37-90 kW' },
    { code: 'FC302', name: 'VLT AutomationDrive FC 302', powerRange: '0.25-75 kW' },
    { code: 'FC360', name: 'VLT HVAC Drive FC 360', powerRange: '1.1-90 kW' },
    { code: 'VACON100', name: 'VACON 100 Industrial', powerRange: '0.55-800 kW' },
    { code: 'VACON20', name: 'VACON 20 General Purpose', powerRange: '0.25-18.5 kW' },
  ],
  [VfdBrand.ABB]: [
    { code: 'ACS580', name: 'ACS580 General Purpose', powerRange: '0.75-500 kW' },
    { code: 'ACS880', name: 'ACS880 Industrial', powerRange: '0.55-6000 kW' },
    { code: 'ACS355', name: 'ACS355 Machinery', powerRange: '0.37-22 kW' },
    { code: 'ACS310', name: 'ACS310 Water & Wastewater', powerRange: '0.37-22 kW' },
    { code: 'ACH580', name: 'ACH580 HVAC', powerRange: '0.75-500 kW' },
  ],
  [VfdBrand.SIEMENS]: [
    { code: 'G120', name: 'SINAMICS G120', powerRange: '0.37-250 kW' },
    { code: 'G120C', name: 'SINAMICS G120C Compact', powerRange: '0.55-132 kW' },
    { code: 'G120X', name: 'SINAMICS G120X Infrastructure', powerRange: '0.75-630 kW' },
    { code: 'S120', name: 'SINAMICS S120', powerRange: '0.12-4500 kW' },
    { code: 'V20', name: 'SINAMICS V20', powerRange: '0.12-30 kW' },
  ],
  [VfdBrand.SCHNEIDER]: [
    { code: 'ATV320', name: 'Altivar 320 Machines', powerRange: '0.18-15 kW' },
    { code: 'ATV340', name: 'Altivar 340 Process', powerRange: '0.75-75 kW' },
    { code: 'ATV630', name: 'Altivar 630 Process', powerRange: '0.75-800 kW' },
    { code: 'ATV930', name: 'Altivar 930 Process', powerRange: '0.75-800 kW' },
    { code: 'ATV212', name: 'Altivar 212 HVAC', powerRange: '0.75-75 kW' },
  ],
  [VfdBrand.YASKAWA]: [
    { code: 'GA700', name: 'GA700 Industrial', powerRange: '0.4-630 kW' },
    { code: 'GA500', name: 'GA500 General Purpose', powerRange: '0.1-30 kW' },
    { code: 'A1000', name: 'A1000 High Performance', powerRange: '0.4-630 kW' },
    { code: 'V1000', name: 'V1000 Compact', powerRange: '0.1-18.5 kW' },
    { code: 'U1000', name: 'U1000 Matrix', powerRange: '9-315 kW' },
  ],
  [VfdBrand.DELTA]: [
    { code: 'MS300', name: 'MS300 Standard', powerRange: '0.4-22 kW' },
    { code: 'MH300', name: 'MH300 High Performance', powerRange: '0.4-22 kW' },
    { code: 'C2000', name: 'C2000 Advanced', powerRange: '0.4-450 kW' },
    { code: 'CP2000', name: 'CP2000 Elevator', powerRange: '2.2-75 kW' },
    { code: 'VFD-E', name: 'VFD-E Economy', powerRange: '0.2-22 kW' },
  ],
  [VfdBrand.MITSUBISHI]: [
    { code: 'FR-A800', name: 'FR-A800 High Performance', powerRange: '0.4-500 kW' },
    { code: 'FR-E800', name: 'FR-E800 Compact', powerRange: '0.1-15 kW' },
    { code: 'FR-F800', name: 'FR-F800 Fan & Pump', powerRange: '0.75-630 kW' },
    { code: 'FR-D700', name: 'FR-D700 Simple', powerRange: '0.1-7.5 kW' },
    { code: 'FR-A700', name: 'FR-A700 Standard', powerRange: '0.4-500 kW' },
  ],
  [VfdBrand.ROCKWELL]: [
    { code: 'PF525', name: 'PowerFlex 525', powerRange: '0.4-22 kW' },
    { code: 'PF527', name: 'PowerFlex 527', powerRange: '0.4-22 kW' },
    { code: 'PF753', name: 'PowerFlex 753', powerRange: '0.37-250 kW' },
    { code: 'PF755', name: 'PowerFlex 755', powerRange: '0.75-3000 kW' },
    { code: 'PF4', name: 'PowerFlex 4', powerRange: '0.2-11 kW' },
  ],
};

// ============ DEFAULT PROTOCOL CONFIGURATIONS ============

export const VFD_DEFAULT_MODBUS_RTU_CONFIG: ModbusRtuConfig = {
  serialPort: 'COM1',
  slaveId: 1,
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  timeout: 1000,
  retryCount: 3,
};

export const VFD_DEFAULT_MODBUS_TCP_CONFIG: ModbusTcpConfig = {
  host: '192.168.1.100',
  port: 502,
  unitId: 1,
  connectionTimeout: 5000,
  responseTimeout: 3000,
  keepAlive: true,
};

export const VFD_DEFAULT_PROFINET_CONFIG: ProfinetConfig = {
  deviceName: 'vfd-device',
  ipAddress: '192.168.1.100',
  subnetMask: '255.255.255.0',
  updateRate: 32,
};

export const VFD_DEFAULT_ETHERNET_IP_CONFIG: EthernetIpConfig = {
  host: '192.168.1.100',
  port: 44818,
  assemblyInstance: {
    input: 100,
    output: 150,
  },
  rpi: 10,
  connectionType: 'exclusive',
};

export const VFD_DEFAULT_CANOPEN_CONFIG: CanopenConfig = {
  nodeId: 1,
  baudRate: 250000,
  interface: 'can0',
  heartbeatProducerTime: 1000,
  sdoTimeout: 1000,
};

export const VFD_DEFAULT_BACNET_IP_CONFIG: BacnetIpConfig = {
  ipAddress: '192.168.1.100',
  port: 47808,
  deviceInstance: 1234,
  maxApduLength: 1476,
  segmentationSupported: true,
};
