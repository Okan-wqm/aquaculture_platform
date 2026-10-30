/**
 * The stable codes (GraphQL `extensions.code`) of sensor-service's refusals to
 * issue or rotate a sensor's own broker credential (ADR-047), so the device
 * page says in the user's language why. Append-only.
 */
export const SENSOR_MQTT_IDENTITY_ERROR = {
  /** Only a sensor that speaks MQTT itself holds a broker credential. */
  NOT_MQTT: 'MQTT_IDENTITY_NOT_MQTT',
  /** A child sensor shares its parent device's connection; the parent holds the credential. */
  FOLLOWS_PARENT: 'MQTT_IDENTITY_FOLLOWS_PARENT',
  /** A suspended sensor gets a new credential when it is reactivated, not before. */
  SUSPENDED: 'MQTT_IDENTITY_SUSPENDED',
  /** The service holds no key to issue credentials with; nothing was changed. */
  UNAVAILABLE: 'MQTT_IDENTITY_UNAVAILABLE',
} as const;

export type SensorMqttIdentityErrorCode =
  (typeof SENSOR_MQTT_IDENTITY_ERROR)[keyof typeof SENSOR_MQTT_IDENTITY_ERROR];

const CODES: ReadonlySet<string> = new Set(Object.values(SENSOR_MQTT_IDENTITY_ERROR));

/** Whether an error code is one of the broker-credential refusals. */
export function isSensorMqttIdentityErrorCode(code: unknown): code is SensorMqttIdentityErrorCode {
  return typeof code === 'string' && CODES.has(code);
}
