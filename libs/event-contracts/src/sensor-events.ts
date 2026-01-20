import { BaseEvent } from './base-event';

/**
 * Sensor Reading Event
 * Published when sensor data is ingested
 */
export interface SensorReadingEvent extends BaseEvent {
  eventType: 'SensorReading';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  readings: {
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    salinity?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
    turbidity?: number;
    [key: string]: number | undefined;
  };
}

/**
 * Sensor Registered Event
 */
export interface SensorRegisteredEvent extends BaseEvent {
  eventType: 'SensorRegistered';
  sensorId: string;
  farmId: string;
  pondId?: string;
  sensorType: string;
  manufacturer?: string;
  model?: string;
}

/**
 * Sensor Calibration Event
 */
export interface SensorCalibratedEvent extends BaseEvent {
  eventType: 'SensorCalibrated';
  sensorId: string;
  calibrationDate: Date;
  calibrationValues: Record<string, number>;
  calibratedBy?: string;
  nextCalibrationDate?: Date;
}

/**
 * Sensor Offline Event
 */
export interface SensorOfflineEvent extends BaseEvent {
  eventType: 'SensorOffline';
  sensorId: string;
  farmId: string;
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
  farmId: string;
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
  testedBy?: string;
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
  changedBy: string;
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
  registeredBy: string;
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
  registeredBy: string;
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
  updatedBy: string;
}

/**
 * Sensor Suspended Event
 */
export interface SensorSuspendedEvent extends BaseEvent {
  eventType: 'SensorSuspended';
  sensorId: string;
  reason: string;
  suspendedBy: string;
}

/**
 * Sensor Reactivated Event
 */
export interface SensorReactivatedEvent extends BaseEvent {
  eventType: 'SensorReactivated';
  sensorId: string;
  reactivatedBy: string;
}

/**
 * Sensor Discovery Started Event
 */
export interface SensorDiscoveryStartedEvent extends BaseEvent {
  eventType: 'SensorDiscoveryStarted';
  protocolCode: string;
  networkRange?: string;
  startedBy: string;
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
 * Union type for all sensor events
 */
export type SensorEvent =
  | SensorReadingEvent
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
  | SensorDiscoveryCompletedEvent;
