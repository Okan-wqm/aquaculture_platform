import { BaseEvent } from './base-event';

/**
 * Sensor Reading Event (v2 — flat fields)
 * Published when sensor data is ingested.
 *
 * ARCH-C01: readings are flat `readingXxx` fields instead of nested `readings` object.
 * Legacy v1 events with nested `readings` are upcasted by SensorReadingUpcaster.
 */
export interface SensorReadingEvent extends BaseEvent {
  eventType: 'SensorReading';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  readingTemperature?: number;
  readingPh?: number;
  readingDissolvedOxygen?: number;
  readingSalinity?: number;
  readingAmmonia?: number;
  readingNitrite?: number;
  readingNitrate?: number;
  readingTurbidity?: number;
  readingWaterLevel?: number;
}

/**
 * Sensor Metric Ingested Event (Faz 3 — Rust sidecar → sensor-service edge)
 *
 * WHY this event exists separately from `SensorReadingEvent`:
 *   The Rust ingestion sidecar (`apps/sensor-ingestion`, ADR-025) sees
 *   raw per-channel metric tuples — it does NOT have the sensor-meta
 *   cache that maps channel UUID → typed water-quality field
 *   (`readingTemperature`, `readingPh`, ...). Forcing the sidecar to
 *   publish typed `SensorReadingEvent`s would couple the ingestion hot
 *   path to a control-plane lookup that lives in sensor-service.
 *
 *   Architectural cut (ADR-022 control / data plane separation):
 *     - Rust sidecar publishes the raw shape it OWNS.
 *     - sensor-service NATS consumer enriches with sensor-meta from its
 *       in-process cache, calls `BatchProcessorService.enqueue()`, then
 *       emits the existing typed `SensorReadingEvent` to the in-process
 *       EventBus for downstream consumers (alert-engine).
 *
 *   Result: no breakage of the typed `SensorReadingEvent` contract,
 *   sidecar does what it can with what it has, mapping concern lives
 *   exactly once in the service that owns the metadata.
 *
 * Wire shape:
 *   `tenantId` is the BaseEvent.tenantId (subject routing).
 *   `producerTs` is ms-epoch UTC (matches the Rust sidecar's
 *   `validate()` post-condition; same numeric type + range as the
 *   `[2024-01-01, 2100-01-01)` window the validator enforces).
 */
export interface SensorMetricIngestedEvent extends BaseEvent {
  eventType: 'SensorMetricIngested';
  sensorId: string;
  channelId: string;
  rawValue: number;
  value: number;
  qualityCode: number;
  producerTs: number;
  /**
   * Optional farm scope, populated by the Rust sidecar's drain when the
   * `(tenant, sensor)` pair was present in the warm `TopicCache`.
   *
   * WHAT this field carries:
   *   The sidecar's resolved `sensor.farmId` at the moment the event
   *   was minted. The NestJS `NatsIngestionConsumerService` prefers
   *   this value (event-side) over its own `metaCache.getSensor()`
   *   result so the per-event DB roundtrip is skipped on the warm-
   *   cache happy path. When the sidecar's cache was cold the field
   *   is absent and the consumer falls back to its own cache (defence
   *   in depth + fresher-cache-wins on staleness).
   *
   * WHY optional:
   *   Cache-miss path on the sidecar leaves this absent — making it
   *   required would couple every cold-start ingest to a synchronous
   *   responder roundtrip, which is exactly the architectural cut the
   *   sidecar's cache exists to avoid.
   *
   * Wire shape: absent (key omitted) when the sidecar had no farm
   * binding, never `null`. Mirrors the Rust struct's
   * `skip_serializing_if = "Option::is_none"`.
   */
  farmId?: string;
  /**
   * Optional pond scope. Mirrors `farmId` semantics — populated when
   * the sidecar's cache was warm at publish time, absent otherwise.
   */
  pondId?: string;
}

/**
 * Sensor Registered Event
 */
export interface SensorRegisteredEvent extends BaseEvent {
  eventType: 'SensorRegistered';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  sensorType: string;
  manufacturer?: string;
  model?: string;
}

/**
 * Sensor Calibration Event
 *
 * ARCH-C01: calibrationValues serialized as JSON string — device-specific keys
 * make flat-field mapping impractical.
 */
export interface SensorCalibratedEvent extends BaseEvent {
  eventType: 'SensorCalibrated';
  sensorId: string;
  calibrationDate: Date;
  calibrationValuesJson: string;
  nextCalibrationDate?: Date;
}

/**
 * Sensor Offline Event
 */
export interface SensorOfflineEvent extends BaseEvent {
  eventType: 'SensorOffline';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  lastReadingAt: Date;
  reason?: string;
}

/**
 * Sensor Online Event
 */
export interface SensorOnlineEvent extends BaseEvent {
  eventType: 'SensorOnline';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  reconnectedAt: Date;
}

/**
 * Sensor Connection Tested Event
 */
export interface SensorConnectionTestedEvent extends BaseEvent {
  eventType: 'SensorConnectionTested';
  sensorId: string;
  protocolCode: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  sampleDataReceived?: boolean;
}

/**
 * Sensor Protocol Changed Event
 */
export interface SensorProtocolChangedEvent extends BaseEvent {
  eventType: 'SensorProtocolChanged';
  sensorId: string;
  previousProtocol?: string;
  newProtocol: string;
  reason?: string;
}

/**
 * Sensor Registration Started Event
 */
export interface SensorRegistrationStartedEvent extends BaseEvent {
  eventType: 'SensorRegistrationStarted';
  sensorId: string;
  sensorName: string;
  protocolCode: string;
}

/**
 * Sensor Registration Completed Event
 */
export interface SensorRegistrationCompletedEvent extends BaseEvent {
  eventType: 'SensorRegistrationCompleted';
  sensorId: string;
  sensorName: string;
  protocolCode: string;
  farmId?: string;
  pondId?: string;
  connectionTestPassed: boolean;
}

/**
 * Sensor Configuration Updated Event
 */
export interface SensorConfigurationUpdatedEvent extends BaseEvent {
  eventType: 'SensorConfigurationUpdated';
  sensorId: string;
  protocolCode: string;
  changedFields: string[];
}

/**
 * Sensor Suspended Event
 */
export interface SensorSuspendedEvent extends BaseEvent {
  eventType: 'SensorSuspended';
  sensorId: string;
  reason: string;
}

/**
 * Sensor Reactivated Event
 */
export interface SensorReactivatedEvent extends BaseEvent {
  eventType: 'SensorReactivated';
  sensorId: string;
}

/**
 * Sensor Discovery Started Event
 */
export interface SensorDiscoveryStartedEvent extends BaseEvent {
  eventType: 'SensorDiscoveryStarted';
  protocolCode: string;
  networkRange?: string;
}

/**
 * Sensor Discovery Completed Event
 */
export interface SensorDiscoveryCompletedEvent extends BaseEvent {
  eventType: 'SensorDiscoveryCompleted';
  protocolCode: string;
  devicesFound: number;
  discoveredDevices: Array<{
    address: string;
    name?: string;
    manufacturer?: string;
    model?: string;
  }>;
}

/**
 * Parent Reading Routed Event
 * Published when a parent device reading is routed to child sensors
 */
export interface ParentReadingRoutedEvent extends BaseEvent {
  eventType: 'ParentReadingRouted';
  parentId: string;
  childCount: number;
  processedCount: number;
  errorCount: number;
}

// ==================== SCADA Package Lifecycle Events ====================

/**
 * SCADA Package Deployed Event
 * Published when a SCADA package is sent (deployed) to an edge device.
 */
export interface ScadaPackageDeployedEvent extends BaseEvent {
  eventType: 'ScadaPackageDeployed';
  packageId: string;
  deviceId: string;
  commandId: string;
  packageVersion: number;
  deployedBy?: string;
}

/**
 * SCADA Deploy Succeeded Event
 * Published when the edge device confirms successful SCADA deployment.
 */
export interface ScadaDeploySucceededEvent extends BaseEvent {
  eventType: 'ScadaDeploySucceeded';
  packageId: string;
  deviceId: string;
  commandId: string;
  packageVersion: number;
}

/**
 * SCADA Deploy Failed Event
 * Published when the edge device reports a SCADA deployment failure.
 */
export interface ScadaDeployFailedEvent extends BaseEvent {
  eventType: 'ScadaDeployFailed';
  packageId: string;
  deviceId: string;
  commandId: string;
  packageVersion: number;
  errorMessage?: string;
}

// ==================== Type Union ====================

/**
 * Union type for all sensor events
 */
export type SensorEvent =
  | SensorReadingEvent
  | SensorMetricIngestedEvent
  | SensorRegisteredEvent
  | SensorCalibratedEvent
  | SensorOfflineEvent
  | SensorOnlineEvent
  | SensorConnectionTestedEvent
  | SensorProtocolChangedEvent
  | SensorRegistrationStartedEvent
  | SensorRegistrationCompletedEvent
  | SensorConfigurationUpdatedEvent
  | SensorSuspendedEvent
  | SensorReactivatedEvent
  | SensorDiscoveryStartedEvent
  | SensorDiscoveryCompletedEvent
  | ParentReadingRoutedEvent
  | ScadaPackageDeployedEvent
  | ScadaDeploySucceededEvent
  | ScadaDeployFailedEvent;
