import Ajv, { type ValidateFunction } from 'ajv';

/**
 * Trust-boundary schema for a message a sensor publishes with its own broker
 * principal on `tenants/{tenantId}/sensors/{sensorId}/data` (ADR-047 §8).
 *
 * The device is outside the platform, so its payload is checked before any
 * of it is read: one JSON object, nested at most SENSOR_DATA_PAYLOAD_MAX_DEPTH
 * levels below the top, at most SENSOR_DATA_PAYLOAD_MAX_KEYS keys or items per
 * level and SENSOR_DATA_PAYLOAD_MAX_STRING characters per string. An optional
 * `timestamp` is a scalar; ingestion uses it as the sample time only when it is
 * RFC 3339 with an explicit offset (SENSOR_DATA_TIMESTAMP_PATTERN) and within
 * the trusted skew, and otherwise stores the message at its arrival time — a
 * device whose clock format is off still delivers its readings. Other keys (a
 * simulator's `deviceId`) are allowed and ignored. Each enabled channel's
 * `dataPath` (or channel key) names a value in it, which must be a JSON
 * number: that per-sensor check runs at ingestion, where the channels are
 * known. The wire size bound, SENSOR_DATA_PAYLOAD_MAX_BYTES, is checked on the
 * bytes before parsing.
 */

/** The largest payload, in bytes, a sensor data message may carry. */
export const SENSOR_DATA_PAYLOAD_MAX_BYTES = 16_384;
/** How many levels a value may nest below the top-level object. */
export const SENSOR_DATA_PAYLOAD_MAX_DEPTH = 3;
/** Keys per object and items per array, at any level. */
export const SENSOR_DATA_PAYLOAD_MAX_KEYS = 64;
/** Characters per string value. */
export const SENSOR_DATA_PAYLOAD_MAX_STRING = 256;

/** A payload timestamp ingestion can use: RFC 3339 with an explicit offset. */
export const SENSOR_DATA_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const SCALAR = {
  anyOf: [
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'string', maxLength: SENSOR_DATA_PAYLOAD_MAX_STRING },
  ],
} as const;

/** A value that may nest `depth` more levels: a scalar, or an object or array of shallower values. */
function valueNesting(depth: number): object {
  if (depth === 0) {
    return SCALAR;
  }
  const inner = valueNesting(depth - 1);
  return {
    anyOf: [
      SCALAR,
      { type: 'object', maxProperties: SENSOR_DATA_PAYLOAD_MAX_KEYS, additionalProperties: inner },
      { type: 'array', maxItems: SENSOR_DATA_PAYLOAD_MAX_KEYS, items: inner },
    ],
  };
}

const SENSOR_DATA_PAYLOAD_SCHEMA = {
  type: 'object',
  maxProperties: SENSOR_DATA_PAYLOAD_MAX_KEYS,
  properties: {
    timestamp: SCALAR,
  },
  additionalProperties: valueNesting(SENSOR_DATA_PAYLOAD_MAX_DEPTH),
};

const ajv = new Ajv({ strict: false, allErrors: false });

export const validateSensorDataPayload: ValidateFunction = ajv.compile(SENSOR_DATA_PAYLOAD_SCHEMA);
