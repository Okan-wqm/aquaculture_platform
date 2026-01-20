// Protocol types
export enum ProtocolCategory {
  INDUSTRIAL = 'industrial',
  IOT = 'iot',
  SERIAL = 'serial',
  WIRELESS = 'wireless',
}

export enum ProtocolSubcategory {
  // Industrial
  MODBUS = 'modbus',
  OPC = 'opc',
  PLC = 'plc',
  FIELDBUS = 'fieldbus',
  BUILDING = 'building',
  // IoT
  MQTT = 'mqtt',
  HTTP = 'http',
  WEBSOCKET = 'websocket',
  COAP = 'coap',
  AMQP = 'amqp',
  DDS = 'dds',
  // Serial
  TCP = 'tcp',
  UDP = 'udp',
  RS232 = 'rs232',
  RS485 = 'rs485',
  I2C = 'i2c',
  SPI = 'spi',
  ONEWIRE = 'onewire',
  // Wireless
  LORAWAN = 'lorawan',
  ZIGBEE = 'zigbee',
  BLE = 'ble',
  ZWAVE = 'zwave',
  ESPNOW = 'espnow',
  THREAD = 'thread',
}

export enum ConnectionType {
  TCP = 'tcp',
  UDP = 'udp',
  SERIAL = 'serial',
  WIRELESS = 'wireless',
  USB = 'usb',
}

export interface ProtocolCapabilities {
  supportsDiscovery?: boolean;
  supportsBidirectional?: boolean;
  supportsPolling?: boolean;
  supportsSubscription?: boolean;
  supportsAuthentication?: boolean;
  supportsEncryption?: boolean;
  supportedDataTypes?: string[];
  supportsStreaming?: boolean;
  supportsBatch?: boolean;
  requiresGateway?: boolean;
  maxPollingRate?: number;
  maxDevicesPerConnection?: number;
}

export interface ProtocolInfo {
  code: string;
  displayName: string;
  description: string;
  category: ProtocolCategory;
  subcategory: ProtocolSubcategory | string;
  connectionType: ConnectionType | string;
  capabilities?: ProtocolCapabilities;
  isActive?: boolean;
}

export interface ProtocolSummary {
  code: string;
  name: string;
  category: ProtocolCategory;
  subcategory: string;
}

export interface ProtocolDetails extends ProtocolInfo {
  name: string;
  configurationSchema: JSONSchema;
  defaultConfiguration: Record<string, unknown>;
  capabilities?: ProtocolCapabilities;
  documentationUrl?: string;
}

// JSON Schema types for dynamic form
export interface JSONSchema {
  type: string;
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JSONSchemaProperty>;
  'ui:groups'?: UIGroup[];
}

export interface JSONSchemaProperty {
  type: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  format?: string;
  items?: JSONSchemaProperty;
  'ui:order'?: number;
  'ui:group'?: string;
  'ui:widget'?: string;
  'ui:placeholder'?: string;
}

export interface UIGroup {
  name: string;
  title: string;
  fields: string[];
}

// Sensor types - use lowercase to match backend
export enum SensorType {
  TEMPERATURE = 'temperature',
  PH = 'ph',
  DISSOLVED_OXYGEN = 'dissolved_oxygen',
  AMMONIA = 'ammonia',
  NITRITE = 'nitrite',
  NITRATE = 'nitrate',
  SALINITY = 'salinity',
  TURBIDITY = 'turbidity',
  WATER_LEVEL = 'water_level',
  FLOW_RATE = 'flow_rate',
  PRESSURE = 'pressure',
  CONDUCTIVITY = 'conductivity',
  ORP = 'orp',
  CO2 = 'co2',
  CHLORINE = 'chlorine',
  MULTI_PARAMETER = 'multi_parameter',
  CAMERA = 'camera',
  OTHER = 'other',
}

// Sensor status enum
export enum SensorStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
  OFFLINE = 'offline',
}

export enum SensorRegistrationStatus {
  DRAFT = 'draft',
  PENDING_TEST = 'pending_test',
  TESTING = 'testing',
  TEST_FAILED = 'test_failed',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export interface SensorConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: string;
  lastSuccessfulConnection?: string;
  lastError?: string;
  errorCode?: string;
  latencyMs?: number;
  signalStrength?: number;
  batteryLevel?: number;
  firmwareVersion?: string;
  diagnostics?: Record<string, unknown>;
}

export interface RegisteredSensor {
  id: string;
  name: string;
  type: SensorType;
  protocolCode: string;
  protocolConfiguration: Record<string, unknown>;
  connectionStatus?: SensorConnectionStatus;
  registrationStatus: SensorRegistrationStatus;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

// Input types
export interface RegisterSensorInput {
  name: string;
  type: SensorType;
  protocolCode: string;
  protocolConfiguration: Record<string, unknown>;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
  skipConnectionTest?: boolean;
  dataChannels?: DataChannelConfig[];
}

export interface UpdateSensorProtocolInput {
  sensorId: string;
  protocolCode?: string;
  protocolConfiguration: Record<string, unknown>;
}

export interface UpdateSensorInfoInput {
  sensorId: string;
  name?: string;
  type?: SensorType;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

// Result types
export interface SensorRegistrationResult {
  success: boolean;
  sensor?: RegisteredSensor;
  error?: string;
  connectionTestPassed?: boolean;
  latencyMs?: number;
}

export interface ConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
  sampleData?: Record<string, unknown>;
  testedAt: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
}

// List types
export interface SensorList {
  items: RegisteredSensor[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SensorFilter {
  type?: SensorType;
  protocolCode?: string;
  registrationStatus?: SensorRegistrationStatus;
  farmId?: string;
  pondId?: string;
  tankId?: string;
  search?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

// Stats types
export interface SensorStats {
  total: number;
  active: number;
  inactive: number;
  testing: number;
  failed: number;
  byType: Record<string, number>;
  byProtocol: Record<string, number>;
}

export interface CategoryStats {
  category: ProtocolCategory;
  totalProtocols: number;
  activeProtocols: number;
  subcategories: (ProtocolSubcategory | string)[];
}

// Wizard state types
export interface WizardStep {
  id: string;
  title: string;
  description?: string;
  isComplete: boolean;
  isActive: boolean;
}

export interface RegistrationWizardState {
  currentStep: number;
  steps: WizardStep[];
  selectedProtocol?: ProtocolInfo;
  basicInfo: Partial<RegisterSensorInput>;
  protocolConfig: Record<string, unknown>;
  connectionTestResult?: ConnectionTestResult;
  dataChannels: DataChannelConfig[];
  isSubmitting: boolean;
  error?: string;
}

// === Data Channel Types ===

export enum ChannelDataType {
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  STRING = 'string',
  ENUM = 'enum',
}

export enum DiscoverySource {
  AUTO = 'auto',
  MANUAL = 'manual',
  TEMPLATE = 'template',
}

export interface AlertThresholdValue {
  low?: number;
  high?: number;
}

export interface AlertThresholds {
  warning?: AlertThresholdValue;
  critical?: AlertThresholdValue;
  hysteresis?: number;
}

export interface ChannelDisplaySettings {
  color?: string;
  icon?: string;
  widgetType?: 'gauge' | 'sparkline' | 'number' | 'status';
  precision?: number;
  showOnDashboard?: boolean;
  chartConfig?: Record<string, unknown>;
}

export interface DataChannelConfig {
  id?: string;
  channelKey: string;
  displayLabel: string;
  description?: string;
  dataType: ChannelDataType;
  unit?: string;
  dataPath?: string;
  minValue?: number;
  maxValue?: number;
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;
  alertThresholds?: AlertThresholds;
  displaySettings?: ChannelDisplaySettings;
  isEnabled: boolean;
  displayOrder: number;
  discoverySource?: DiscoverySource;
  sampleValue?: unknown;
}

export interface DiscoveredChannel {
  channelKey: string;
  suggestedLabel: string;
  inferredDataType: ChannelDataType;
  inferredUnit?: string;
  sampleValue?: unknown;
  dataPath?: string;
  suggestedMin?: number;
  suggestedMax?: number;
}

export interface DiscoveryResult {
  success: boolean;
  channels: DiscoveredChannel[];
  sampleData?: Record<string, unknown>;
  error?: string;
  rawPayload?: unknown;
}

// === Parent-Child Sensor Types ===

export enum SensorRole {
  PARENT = 'parent',
  CHILD = 'child',
}

/**
 * Parent device information for multi-parameter sensors
 */
export interface ParentDeviceInfo {
  name: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  // Legacy location fields (deprecated)
  farmId?: string;
  pondId?: string;
  tankId?: string;
  // New location hierarchy fields
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  equipmentId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Child sensor configuration for each data value from parent device
 */
export interface ChildSensorConfig {
  // Data path (JSON key from parent payload)
  dataPath: string;

  // Basic sensor info
  name: string;
  type: SensorType;
  unit?: string;

  // Sample value from test
  sampleValue?: unknown;

  // Value range
  minValue?: number;
  maxValue?: number;

  // Calibration
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;

  // Alert thresholds
  alertThresholds?: AlertThresholds;

  // Dashboard display
  displaySettings?: ChannelDisplaySettings;

  // Selection state (for wizard)
  selected: boolean;

  // Configuration status
  isConfigured: boolean;
}

/**
 * Input for registering a parent device
 */
export interface RegisterParentDeviceInput {
  name: string;
  protocolCode: string;
  protocolConfiguration: Record<string, unknown>;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  // Legacy location fields (deprecated)
  farmId?: string;
  pondId?: string;
  tankId?: string;
  // New location hierarchy fields
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  equipmentId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for registering a child sensor
 */
export interface RegisterChildSensorInput {
  name: string;
  type: SensorType;
  dataPath: string;
  unit?: string;
  minValue?: number;
  maxValue?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: AlertThresholds;
  displaySettings?: ChannelDisplaySettings;
}

/**
 * Input for registering parent with all children
 */
export interface RegisterParentWithChildrenInput {
  parent: RegisterParentDeviceInput;
  children: RegisterChildSensorInput[];
  skipConnectionTest?: boolean;
}

/**
 * Registered parent device
 */
export interface RegisteredParentDevice {
  id: string;
  name: string;
  protocolCode: string;
  protocolConfiguration: Record<string, unknown>;
  connectionStatus?: SensorConnectionStatus;
  registrationStatus: SensorRegistrationStatus;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  description?: string;
  // Legacy location fields (deprecated)
  farmId?: string;
  pondId?: string;
  tankId?: string;
  // New location hierarchy fields
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  equipmentId?: string;
  location?: string;
  childSensors?: RegisteredChildSensor[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Registered child sensor
 */
export interface RegisteredChildSensor {
  id: string;
  name: string;
  type: SensorType;
  dataPath: string;
  unit?: string;
  minValue?: number;
  maxValue?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: AlertThresholds;
  displaySettings?: ChannelDisplaySettings;
  registrationStatus: SensorRegistrationStatus;
  tenantId: string;
  createdAt: string;
}

/**
 * Result of parent-child registration
 */
export interface ParentWithChildrenResult {
  success: boolean;
  parent?: RegisteredParentDevice;
  children?: RegisteredChildSensor[];
  error?: string;
  connectionTestPassed?: boolean;
  latencyMs?: number;
}

/**
 * Updated wizard state for parent-child flow
 */
export interface ParentChildWizardState {
  currentStep: number;

  // Protocol
  selectedProtocol?: ProtocolInfo;
  protocolConfig: Record<string, unknown>;

  // Connection test
  connectionTestResult?: ConnectionTestResult;
  discoveredValues?: DiscoveredChannel[];

  // Parent device info
  parentDeviceInfo: ParentDeviceInfo;

  // Child sensors configuration
  childSensors: ChildSensorConfig[];

  // State
  isSubmitting: boolean;
  error?: string;
}

/**
 * Known parameter mappings for auto-discovery
 */
export const KNOWN_PARAMETERS: Record<string, {
  type: SensorType;
  label: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
}> = {
  temperature: { type: SensorType.TEMPERATURE, label: 'Temperature', unit: '°C', minValue: 0, maxValue: 50 },
  temp: { type: SensorType.TEMPERATURE, label: 'Temperature', unit: '°C', minValue: 0, maxValue: 50 },
  ph: { type: SensorType.PH, label: 'pH', unit: 'pH', minValue: 0, maxValue: 14 },
  dissolved_oxygen: { type: SensorType.DISSOLVED_OXYGEN, label: 'Dissolved Oxygen', unit: 'mg/L', minValue: 0, maxValue: 20 },
  do: { type: SensorType.DISSOLVED_OXYGEN, label: 'Dissolved Oxygen', unit: 'mg/L', minValue: 0, maxValue: 20 },
  oxygen: { type: SensorType.DISSOLVED_OXYGEN, label: 'Dissolved Oxygen', unit: 'mg/L', minValue: 0, maxValue: 20 },
  salinity: { type: SensorType.SALINITY, label: 'Salinity', unit: 'ppt', minValue: 0, maxValue: 45 },
  salt: { type: SensorType.SALINITY, label: 'Salinity', unit: 'ppt', minValue: 0, maxValue: 45 },
  ammonia: { type: SensorType.AMMONIA, label: 'Ammonia', unit: 'mg/L', minValue: 0, maxValue: 10 },
  nh3: { type: SensorType.AMMONIA, label: 'Ammonia', unit: 'mg/L', minValue: 0, maxValue: 10 },
  nitrite: { type: SensorType.NITRITE, label: 'Nitrite', unit: 'mg/L', minValue: 0, maxValue: 10 },
  no2: { type: SensorType.NITRITE, label: 'Nitrite', unit: 'mg/L', minValue: 0, maxValue: 10 },
  nitrate: { type: SensorType.NITRATE, label: 'Nitrate', unit: 'mg/L', minValue: 0, maxValue: 100 },
  no3: { type: SensorType.NITRATE, label: 'Nitrate', unit: 'mg/L', minValue: 0, maxValue: 100 },
  turbidity: { type: SensorType.TURBIDITY, label: 'Turbidity', unit: 'NTU', minValue: 0, maxValue: 1000 },
  water_level: { type: SensorType.WATER_LEVEL, label: 'Water Level', unit: 'm', minValue: 0, maxValue: 10 },
  level: { type: SensorType.WATER_LEVEL, label: 'Water Level', unit: 'm', minValue: 0, maxValue: 10 },
  flow_rate: { type: SensorType.FLOW_RATE, label: 'Flow Rate', unit: 'L/min', minValue: 0, maxValue: 1000 },
  flow: { type: SensorType.FLOW_RATE, label: 'Flow Rate', unit: 'L/min', minValue: 0, maxValue: 1000 },
  pressure: { type: SensorType.PRESSURE, label: 'Pressure', unit: 'bar', minValue: 0, maxValue: 10 },
  conductivity: { type: SensorType.CONDUCTIVITY, label: 'Conductivity', unit: 'µS/cm', minValue: 0, maxValue: 100000 },
  ec: { type: SensorType.CONDUCTIVITY, label: 'Conductivity', unit: 'µS/cm', minValue: 0, maxValue: 100000 },
  orp: { type: SensorType.ORP, label: 'ORP', unit: 'mV', minValue: -500, maxValue: 500 },
  co2: { type: SensorType.CO2, label: 'CO2', unit: 'ppm', minValue: 0, maxValue: 5000 },
  chlorine: { type: SensorType.CHLORINE, label: 'Chlorine', unit: 'mg/L', minValue: 0, maxValue: 10 },
};

/**
 * Helper to infer child sensor config from discovered data
 */
export function inferChildSensorConfig(
  dataPath: string,
  sampleValue: unknown,
  parentName?: string,
): ChildSensorConfig {
  const normalizedKey = dataPath.toLowerCase().replace(/[_-]/g, '_');
  const knownParam = KNOWN_PARAMETERS[normalizedKey];

  const baseName = parentName
    ? `${parentName} - ${knownParam?.label || dataPath}`
    : knownParam?.label || dataPath;

  return {
    dataPath,
    name: baseName,
    type: knownParam?.type || SensorType.OTHER,
    unit: knownParam?.unit,
    sampleValue,
    minValue: knownParam?.minValue,
    maxValue: knownParam?.maxValue,
    calibrationEnabled: false,
    calibrationMultiplier: 1,
    calibrationOffset: 0,
    selected: true,
    isConfigured: false,
  };
}
