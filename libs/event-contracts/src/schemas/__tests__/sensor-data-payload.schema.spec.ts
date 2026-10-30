import {
  SENSOR_DATA_PAYLOAD_MAX_KEYS,
  SENSOR_DATA_PAYLOAD_MAX_STRING,
  SENSOR_DATA_TIMESTAMP_PATTERN,
  validateSensorDataPayload,
} from '../sensor-data-payload.schema';

/**
 * ADR-047 §8: what a sensor publishing with its own principal may send — one
 * JSON object within the stated depth, key and string bounds. A timestamp in
 * another form does not cost the message its readings: the schema admits any
 * scalar, and only an RFC 3339 one with its offset is used as the sample time.
 */
describe('sensor data payload schema', () => {
  it.each([
    [{ ph: 7.1, temperature: 18.4 }],
    [{ ph: 7.1, timestamp: '2026-10-30T20:15:00Z', deviceId: 'probe-1' }],
    [{ ph: 7.1, timestamp: '2026-10-30T21:15:00.123+01:00' }],
    [{ sensors: { mid: { value: 3.2 } }, list: [1, 2, 3], ok: true, note: null }],
    [{ a: { b: { c: { d: 1 } } } }],
    [{ ph: 7, timestamp: '2026-10-30T20:15:00' }],
    [{ ph: 7, timestamp: 1793393700 }],
  ])('admits %j', (payload) => {
    expect(validateSensorDataPayload(payload)).toBe(true);
  });

  it.each([
    ['an array', [7.1]],
    ['a number', 7.1],
    ['null', null],
    ['a nested timestamp', { ph: 7, timestamp: { at: 1 } }],
    ['nesting beyond the bound', { a: { b: { c: { d: { e: 1 } } } } }],
    [
      'too many keys',
      Object.fromEntries(
        Array.from({ length: SENSOR_DATA_PAYLOAD_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
      ),
    ],
    ['a long string', { note: 'x'.repeat(SENSOR_DATA_PAYLOAD_MAX_STRING + 1) }],
  ])('refuses %s', (_case, payload) => {
    expect(validateSensorDataPayload(payload)).toBe(false);
  });
});

describe('a usable sensor data timestamp', () => {
  it.each(['2026-10-30T20:15:00Z', '2026-10-30T21:15:00.123+01:00'])('is %s', (value) => {
    expect(SENSOR_DATA_TIMESTAMP_PATTERN.test(value)).toBe(true);
  });

  it.each(['2026-10-30T20:15:00', '2026-10-30 20:15:00Z', '1793393700'])('is not %s', (value) => {
    expect(SENSOR_DATA_TIMESTAMP_PATTERN.test(value)).toBe(false);
  });
});
