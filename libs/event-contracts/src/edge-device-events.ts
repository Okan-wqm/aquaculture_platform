import { BaseEvent } from './base-event';

// ==================== Edge Device Events ====================
// These events are published by sensor-service (MqttListenerService)
// for real-time WebSocket bridging to frontend clients.

/**
 * Edge Device Heartbeat Event
 * Published when an edge device reports health telemetry.
 */
export interface EdgeDeviceHeartbeatEvent extends BaseEvent {
  eventType: 'EdgeDeviceHeartbeat';
  deviceId: string;
  deviceCode: string;
  isOnline: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
}

/**
 * Edge Device Response Event
 * Published when an edge device responds to a command execution.
 */
export interface EdgeDeviceResponseEvent extends BaseEvent {
  eventType: 'EdgeDeviceResponse';
  deviceCode: string;
  commandId?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Edge Device I/O Data Event
 * Published when an edge device sends real-time I/O tag values.
 * Critical for SCADA widget live data binding.
 *
 * ARCH-C01: tags serialized as JSON string — dynamic tag names
 * make flat-field mapping impossible.
 */
export interface EdgeDeviceIoDataEvent extends BaseEvent {
  eventType: 'EdgeDeviceIoData';
  deviceCode: string;
  tagsJson: string;
}

/**
 * Edge Device Alarm Event
 * Published when an edge device reports one or more alarms.
 *
 * ARCH-C01: alarms serialized as JSON string — device-specific alarm fields
 * make flat-field mapping impractical. alarmCount for quick access.
 */
export interface EdgeDeviceAlarmEvent extends BaseEvent {
  eventType: 'EdgeDeviceAlarm';
  deviceCode: string;
  alarmsJson: string;
  alarmCount: number;
}

/**
 * I/O Configuration Push Result Event
 * Published when the edge device acknowledges an I/O configuration push.
 */
export interface IoConfigPushResultEvent extends BaseEvent {
  eventType: 'IoConfigPushResult';
  deviceCode: string;
  commandId?: string;
  success: boolean;
  error?: string;
}

/**
 * LoRa Device Event
 * Published when a LoRaWAN event (join_accept, uplink_summary) is
 * received from an edge device's SX1302 concentrator.
 */
export interface LoRaDeviceEventEvent extends BaseEvent {
  eventType: 'LoRaDeviceEvent';
  deviceCode: string;
  loraEventType: string;
  devEui: string;
  rssi?: number;
  snr?: number;
  frameCountUp?: number;
  devAddr?: string;
}

/**
 * Deploy Bundle Requested Event (enterprise plan Faz 5)
 *
 * Enqueued TRANSACTIONALLY (via @platform/outbox) together with the
 * `release_bundles` PENDING row by the bundle builder, and consumed by
 * sensor-service's own DeployBundleDispatcherService which publishes the
 * `deploy_bundle` MQTT command to the device. The outbox relay's
 * at-least-once delivery means a crash between DB commit and broker
 * publish can never lose (or double-apply — the edge dedupes on
 * commandId) a bundle dispatch.
 */
export interface DeployBundleRequestedEvent extends BaseEvent {
  eventType: 'DeployBundleRequested';
  bundleId: string;
  deviceId: string;
  commandId: string;
}

// ==================== Type Union ====================

/**
 * Union type for all edge device events
 */
export type EdgeDeviceEvent =
  | EdgeDeviceHeartbeatEvent
  | EdgeDeviceResponseEvent
  | EdgeDeviceIoDataEvent
  | EdgeDeviceAlarmEvent
  | IoConfigPushResultEvent
  | LoRaDeviceEventEvent
  | DeployBundleRequestedEvent;
