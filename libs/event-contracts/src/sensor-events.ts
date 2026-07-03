import { BaseEvent } from './base-event';

/**
 * Identifies which sensor reading parameter is the SUBJECT of an event.
 *
 * v3 (federation correlation, Scope B Phase S1.1) introduces this so a
 * consumer that needs to correlate a single reading with a downstream
 * `WaterQualityMeasurement` (farm-service) knows which one of the
 * potentially-many `readingXxx` fields the event is "about" without
 * having to introspect `Object.keys(...).filter(...)`.
 *
 * The string literals match the existing flat-field names dropped of
 * the `reading` prefix — so a consumer can construct
 * `event['reading' + capitalise(parameter)]` to read the value.
 */
export type SensorReadingParameter =
  | 'temperature'
  | 'ph'
  | 'dissolvedOxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'waterLevel';

/**
 * Sensor Reading Event (v3 — federation correlation fields, Scope B Phase S1.1)
 *
 * Published when sensor data is ingested. Consumed by the alert-engine
 * (existing) AND now by farm-service for cross-service `WaterQualityMeasurement`
 * correlation (new — federation Phase S1.3 lands the Tank.sensorReadings
 * field resolver that this contract feeds).
 *
 * # Versioning posture
 *   - v1: nested `readings: {temperature?, ph?, ...}` object. Removed.
 *   - v2: flat `readingXxx` fields (ARCH-C01). The v1→v2 upcaster
 *     (`upcasters/sensor-reading.upcaster.ts`) renames the nested
 *     keys; this transformation is permanent and v1 cannot reach the
 *     bus today.
 *   - v3 (THIS revision): adds OPTIONAL correlation axes `tankId`,
 *     `parameter`, `unit`, `relatedWaterQualityMeasurementId`. All
 *     four are optional so v2 events deserialise as valid v3 — the
 *     v2→v3 upcaster (`upcasters/sensor-reading-v2-to-v3.upcaster.ts`)
 *     is intentionally identity (just a version bump). A consumer
 *     that NEEDS the correlation fields (federation resolver) gates
 *     on their presence; a consumer that doesn't (alert-engine)
 *     ignores them transparently.
 *
 * # Why optional + identity upcaster, not required + backfill
 *
 * Sensor-service's NATS consumer is the only producer today
 * (`apps/sensor-service/src/sensor-service.consumer.ts` re-emits
 * the typed event after enriching from `metaCache`). When sensor-service
 * gains the new fields (Phase S1.2), it populates them at mint time;
 * older in-flight events that pre-date that change still validate.
 * Forcing a backfill across the entire historical event stream would
 * gate this PR on every old-event re-publication path, which is not
 * the architectural cut we want — schema evolution rules in
 * `BaseEvent.version` handle this exact case via additive optional
 * fields.
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

  // ---- v3 federation correlation fields ----------------------------------
  /**
   * Tank the sensor is attached to at event time. When present, the
   * farm-service `Tank.sensorReadings` field resolver (Phase S1.3)
   * uses this to bind the reading to the right tank without a
   * sensor-meta lookup. Absent for legacy / non-tank-mounted sensors;
   * federation resolver falls through to a sensorId-keyed lookup in
   * that case.
   */
  tankId?: string;
  /**
   * Single canonical parameter this reading is "about", from the
   * `SensorReadingParameter` union. Lets a consumer pick the right
   * `readingXxx` field without iterating every flat field. Optional
   * for events that emit multiple reading values at once
   * (multi-channel sensors); the consumer is then expected to read
   * every populated `readingXxx` field.
   */
  parameter?: SensorReadingParameter;
  /**
   * Unit string for the reading value (e.g. `'°C'`, `'mg/L'`,
   * `'ppt'`, `'NTU'`). Optional because most consumers know the
   * unit from `parameter` alone — `'temperature'` is always °C in
   * this codebase. Carrying it explicitly future-proofs against
   * units-of-measure migration without forcing a v4 bump.
   */
  unit?: string;
  /**
   * When sensor-service auto-creates a `WaterQualityMeasurement`
   * row in farm-service from a sensor read (auto-pull pattern, not
   * manual entry), this carries the id of that row so federation
   * consumers can resolve back to the canonical farm-service record
   * without a heuristic timestamp join. Absent when no
   * WaterQualityMeasurement was created (sensor-only events).
   */
  relatedWaterQualityMeasurementId?: string;
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
  calibrationDate: string;
  calibrationValuesJson: string;
  nextCalibrationDate?: string;
}

/**
 * Sensor Offline Event
 */
export interface SensorOfflineEvent extends BaseEvent {
  eventType: 'SensorOffline';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  lastReadingAt: string;
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
  reconnectedAt: string;
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
 * Sensor Deleted Event
 * Published when a sensor aggregate is deleted from the owning service.
 */
export interface SensorDeletedEvent extends BaseEvent {
  eventType: 'SensorDeleted';
  sensorId: string;
  deletedBy?: string;
  reason?: string;
}

/**
 * Sensor Deprovisioned Event
 * Published when downstream device caches and edge sidecars must drop sensor
 * state after a durable owner-side delete/deprovision operation.
 */
export interface SensorDeprovisionedEvent extends BaseEvent {
  eventType: 'SensorDeprovisioned';
  sensorId: string;
  deprovisionedBy?: string;
  reason?: string;
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
  | SensorDeletedEvent
  | SensorDeprovisionedEvent
  | SensorDiscoveryStartedEvent
  | SensorDiscoveryCompletedEvent
  | ParentReadingRoutedEvent
  | ScadaPackageDeployedEvent
  | ScadaDeploySucceededEvent
  | ScadaDeployFailedEvent;
