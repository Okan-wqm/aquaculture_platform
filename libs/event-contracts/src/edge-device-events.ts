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
 * Tags structure: `{ [tagName]: { value: any; quality: string } }`
 */
export interface EdgeDeviceIoDataEvent extends BaseEvent {
  eventType: 'EdgeDeviceIoData';
  deviceCode: string;
  tags: Record<string, { value: unknown; quality: string }>;
}

/**
 * Edge Device Alarm Event
 * Published when an edge device reports one or more alarms.
 *
 * Each alarm object may contain: tag, type, priority, state, value,
 * setpoint, message, and other device-specific fields.
 */
export interface EdgeDeviceAlarmEvent extends BaseEvent {
  eventType: 'EdgeDeviceAlarm';
  deviceCode: string;
  alarms: Array<Record<string, unknown>>;
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
  | LoRaDeviceEventEvent;
