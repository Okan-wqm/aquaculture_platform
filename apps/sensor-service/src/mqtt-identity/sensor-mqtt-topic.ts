/**
 * The topic a sensor holding its own broker principal publishes on (ADR-047
 * §2): assigned by the server from the tenant and sensor ids, never typed and
 * never stored. The ACL admits its owner alone to it, so the topic identifies
 * the publisher; ingestion takes the tenant and sensor from it.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DATA_TOPIC = new RegExp(`^tenants/(${UUID})/sensors/(${UUID})/data$`);

/** The subscription filter covering every sensor's data topic. */
export const SENSOR_MQTT_DATA_FILTER = 'tenants/+/sensors/+/data';

/** The data topic of one sensor. */
export function sensorMqttDataTopic(tenantId: string, sensorId: string): string {
  return `tenants/${tenantId}/sensors/${sensorId}/data`;
}

/**
 * The tenant and sensor a data topic names, or null when the topic is not one
 * (another shape, a wildcard, or ids that are not lowercase UUIDs).
 */
export function parseSensorMqttDataTopic(
  topic: string,
): { tenantId: string; sensorId: string } | null {
  const match = DATA_TOPIC.exec(topic);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { tenantId: match[1], sensorId: match[2] };
}
