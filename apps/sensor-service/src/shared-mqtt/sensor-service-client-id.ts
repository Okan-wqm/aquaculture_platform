import type { ConfigService } from '@nestjs/config';

/**
 * The client ID sensor-service's ingestion listener connects with:
 * `MQTT_CLIENT_ID` plus a fixed suffix, stable across restarts so the broker
 * keeps its persistent QoS1 session (SENSOR-CRITICAL-086). The broker's
 * CONNECT hook reserves it for the `sensor_service` account (ADR-047 §1), so
 * both read it here. Null when MQTT_CLIENT_ID is unset.
 */
export function sensorServiceListenerClientId(config: ConfigService): string | null {
  const prefix = config.get<string>('MQTT_CLIENT_ID')?.trim();
  return prefix ? `${prefix}-main` : null;
}
