import {
  SENSOR_DATA_PAYLOAD_MAX_KEYS,
  SENSOR_DATA_PAYLOAD_MAX_STRING,
  validateSensorDataPayload,
} from '../sensor-data-payload.schema';

/**
 * ADR-047 §8: what a sensor publishing with its own principal may send — one
 * JSON object within the stated depth, key and string bounds, with an optional
 * RFC 3339 timestamp carrying its offset.
 */
describe('sensor data payload schema', () => {
  it.each([
    [{ ph: 7.1, temperature: 18.4 }],
    [{ ph: 7.1, timestamp: '2026-10-30T20:15:00Z', deviceId: 'probe-1' }],
    [{ ph: 7.1, timestamp: '2026-10-30T21:15:00.123+01:00' }],
    [{ sensors: { mid: { value: 3.2 } }, list: [1, 2, 3], ok: true, note: null }],
    [{ a: { b: { c: { d: 1 } } } }],
  ])('admits %j', (payload) => {
    expect(validateSensorDataPayload(payload)).toBe(true);
  });

  it.each([
    ['an array', [7.1]],
    ['a number', 7.1],
    ['null', null],
    ['a timestamp without an offset', { ph: 7, timestamp: '2026-10-30T20:15:00' }],
    ['a numeric timestamp', { ph: 7, timestamp: 1793393700 }],
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
