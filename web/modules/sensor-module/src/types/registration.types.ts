import type {
  RegisterChildSensorInput,
  RegisterParentDeviceInput,
} from '@platform/shared-ui/generated/graphql-types';

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

// Sensor types — the GraphQL WIRE values. A registered GraphQL enum is
// serialized by member NAME ('TEMPERATURE'), not by the backend's TypeScript
// value ('temperature'): sending the lowercase value fails variable coercion
// and rejects the whole registration (SENSOR-HIGH-140). Each value therefore
// equals its member name; tests/invariants/sensor-enum-fe-be-parity.spec.ts
// enforces it.
// SENSOR-HIGH-028: this enum MUST stay a subset of the backend SensorType
// (apps/sensor-service/src/database/entities/sensor.entity.ts). It is a real
// GraphQL enum, so a value the backend does not define makes registerSensor /
// registerParentWithChildren fail with a GraphQL enum-validation error.
// PRESSURE/CAMERA/OTHER were removed because the backend enum (a Postgres enum
// column) does not define them; unknown/pressure channels now fall back to
// MULTI_PARAMETER. A parity invariant enforces the subset relationship.
export enum SensorType {
  TEMPERATURE = 'TEMPERATURE',
  PH = 'PH',
  DISSOLVED_OXYGEN = 'DISSOLVED_OXYGEN',
  AMMONIA = 'AMMONIA',
  NITRITE = 'NITRITE',
  NITRATE = 'NITRATE',
  SALINITY = 'SALINITY',
  TURBIDITY = 'TURBIDITY',
  WATER_LEVEL = 'WATER_LEVEL',
  FLOW_RATE = 'FLOW_RATE',
  CONDUCTIVITY = 'CONDUCTIVITY',
  ORP = 'ORP',
  CO2 = 'CO2',
  CHLORINE = 'CHLORINE',
  MULTI_PARAMETER = 'MULTI_PARAMETER',
}

/**
 * Map a lowercase domain key (a type definition's `typeKey`, a catalog key such
 * as 'dissolved_oxygen') to the SensorType wire value; anything the enum does
 * not define becomes MULTI_PARAMETER, the backend's catch-all.
 */
export function sensorTypeFromKey(key: string | null | undefined): SensorType {
  const candidate = (key ?? '').trim().toUpperCase();
  return (Object.values(SensorType) as string[]).includes(candidate)
    ? (candidate as SensorType)
    : SensorType.MULTI_PARAMETER;
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
  // Mutation results (RegisteredSensorType) expose `protocolCode`; the entity-backed
  // singular `sensor(id)` query exposes `protocolId`. Both are optional so a consumer
  // can read whichever the originating query selected.
  protocolCode?: string;
  protocolId?: string;
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
  // SENSOR-MEDIUM-071: optional custom type-definition; its defaultChannels are
  // bootstrapped server-side inside the registration transaction. Additive to `type`.
  typeDefinitionId?: string;
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
  limit: number;
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
  limit: number;
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

// Backend `protocolCategoryStats` returns a single object keyed by category name,
// each value being the protocol count for that category (CategoryStatsType).
export interface CategoryStats {
  industrial: number;
  iot: number;
  serial: number;
  wireless: number;
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
  // Location hierarchy. The placement unit is exactly one of tankId (a tank,
  // pond or cage — its tanks.id) or equipmentId (non-tank water equipment);
  // see steps/devicePlacement.ts.
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  tankId?: string;
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
  // SENSOR-MEDIUM-071: optional custom type-definition selected in the child form.
  typeDefinitionId?: string;
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
 * Registration mutation inputs — the codegen output of the composed schema, so
 * a field the backend input does not declare (e.g. a channel's `precision` or
 * `hysteresis`) is a compile error here instead of a GRAPHQL_VALIDATION_FAILED
 * at submit (SENSOR-HIGH-140).
 */
export type {
  RegisterChildSensorInput,
  RegisterParentDeviceInput,
  RegisterParentWithChildrenInput,
} from '@platform/shared-ui/generated/graphql-types';

/**
 * Build the wire input for one wizard child. Fields are picked explicitly: the
 * form state also carries UI-only keys (sampleValue, selected, isConfigured)
 * and channel-shaped settings, which the registration input names differently
 * — the form's `precision` is the input's `decimalPlaces`.
 */
export function toRegisterChildInput(child: ChildSensorConfig): RegisterChildSensorInput {
  const bounds = (value: AlertThresholdValue | undefined) =>
    value ? { low: value.low ?? null, high: value.high ?? null } : undefined;
  return {
    name: child.name,
    type: child.type,
    typeDefinitionId: child.typeDefinitionId,
    dataPath: child.dataPath,
    unit: child.unit,
    minValue: child.minValue,
    maxValue: child.maxValue,
    calibrationEnabled: child.calibrationEnabled,
    calibrationMultiplier: child.calibrationMultiplier,
    calibrationOffset: child.calibrationOffset,
    alertThresholds: child.alertThresholds
      ? {
          warning: bounds(child.alertThresholds.warning),
          critical: bounds(child.alertThresholds.critical),
        }
      : undefined,
    displaySettings: child.displaySettings
      ? {
          showOnDashboard: child.displaySettings.showOnDashboard,
          widgetType: child.displaySettings.widgetType,
          color: child.displaySettings.color,
          decimalPlaces: child.displaySettings.precision,
        }
      : undefined,
  };
}

/**
 * Build the wire input for the wizard's parent device. The location hierarchy
 * is sent as collected (SENSOR-HIGH-024), the placement unit as the one key
 * devicePlacement chose: a tank's id as tankId, other water equipment as
 * equipmentId (SENSOR-MEDIUM-172).
 */
export function toRegisterParentInput(
  info: ParentDeviceInfo,
  protocolCode: string,
  protocolConfiguration: Record<string, unknown>,
): RegisterParentDeviceInput {
  return {
    name: info.name,
    protocolCode,
    protocolConfiguration,
    manufacturer: info.manufacturer,
    model: info.model,
    serialNumber: info.serialNumber,
    description: info.description,
    siteId: info.siteId,
    departmentId: info.departmentId,
    systemId: info.systemId,
    tankId: info.tankId,
    equipmentId: info.equipmentId,
    location: info.location,
  };
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
  // Location hierarchy; the placement unit is tankId or equipmentId, never both.
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  tankId?: string;
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
 * SENSOR-MEDIUM-065: the aquaculture parameter catalog now has ONE owner — the
 * backend SSoT (`apps/sensor-service/src/common/sensor-parameter-catalog.ts`),
 * served via the `sensorParameterCatalog` query. The FE consumes it through
 * useSensorParameterCatalog() instead of a hardcoded map that disagreed with the
 * backend on units/ranges (which feed alarm thresholds).
 */
export interface SensorParameterCatalogEntry {
  key: string;
  sensorType: SensorType;
  label: string;
  unit: string;
  min: number;
  max: number;
}

/** Parameter catalog keyed by the normalized (lowercased) channel key. */
export type ParameterCatalog = Record<string, SensorParameterCatalogEntry>;

/**
 * Helper to infer child sensor config from discovered data.
 * `catalog` is the backend SSoT (SENSOR-MEDIUM-065). While it is still loading the
 * catalog is empty, so the child falls back to MULTI_PARAMETER with no prefilled
 * unit/range — exactly the prior no-match behaviour.
 */
export function inferChildSensorConfig(
  dataPath: string,
  sampleValue: unknown,
  parentName: string | undefined,
  catalog: ParameterCatalog,
): ChildSensorConfig {
  const normalizedKey = dataPath.toLowerCase().replace(/[_-]/g, '_');
  const knownParam = catalog[normalizedKey];

  const baseName = parentName
    ? `${parentName} - ${knownParam?.label || dataPath}`
    : knownParam?.label || dataPath;

  return {
    dataPath,
    name: baseName,
    type: knownParam?.sensorType || SensorType.MULTI_PARAMETER,
    unit: knownParam?.unit,
    sampleValue,
    minValue: knownParam?.min,
    maxValue: knownParam?.max,
    calibrationEnabled: false,
    calibrationMultiplier: 1,
    calibrationOffset: 0,
    selected: true,
    isConfigured: false,
  };
}
