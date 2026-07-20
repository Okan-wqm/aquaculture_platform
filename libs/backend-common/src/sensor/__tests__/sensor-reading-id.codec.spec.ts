import {
  decodeSensorReadingId,
  encodeSensorReadingId,
} from '../sensor-reading-id.codec';

const SENSOR_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('SensorReadingIdCodec', () => {
  describe('round-trip', () => {
    it('preserves the sensor id and a microsecond-precision timestamptz anchor', () => {
      // The load-bearing case: microsecond precision a JS Date would truncate.
      const timeText = '2026-07-20 12:34:56.789012+00';

      const decoded = decodeSensorReadingId(encodeSensorReadingId(SENSOR_ID, timeText));

      expect(decoded).toEqual({ sensorId: SENSOR_ID, timeText });
    });

    it('preserves a second-precision anchor (no fractional part)', () => {
      const timeText = '2026-07-20 12:34:56+00';

      const decoded = decodeSensorReadingId(encodeSensorReadingId(SENSOR_ID, timeText));

      expect(decoded).toEqual({ sensorId: SENSOR_ID, timeText });
    });

    it('preserves an ISO-8601 Z-offset anchor', () => {
      const timeText = '2026-07-20T12:34:56.789Z';

      const decoded = decodeSensorReadingId(encodeSensorReadingId(SENSOR_ID, timeText));

      expect(decoded).toEqual({ sensorId: SENSOR_ID, timeText });
    });

    it('preserves a non-UTC numeric offset anchor', () => {
      const timeText = '2026-07-20 12:34:56.500000+03:30';

      const decoded = decodeSensorReadingId(encodeSensorReadingId(SENSOR_ID, timeText));

      expect(decoded).toEqual({ sensorId: SENSOR_ID, timeText });
    });

    it('produces a URL-safe (base64url) id with no padding or +/ characters', () => {
      const id = encodeSensorReadingId(SENSOR_ID, '2026-07-20 12:34:56.789012+00');

      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('fail-closed decode', () => {
    it('returns null for an empty string', () => {
      expect(decodeSensorReadingId('')).toBeNull();
    });

    it('returns null for a plain (non-encoded) uuid — the old stored-row id shape', () => {
      expect(decodeSensorReadingId(SENSOR_ID)).toBeNull();
    });

    it('returns null when the sensor part is not a UUID', () => {
      const id = encodeSensorReadingId('not-a-uuid', '2026-07-20 12:34:56+00');

      expect(decodeSensorReadingId(id)).toBeNull();
    });

    it('returns null when the anchor is not timestamptz text', () => {
      const id = Buffer.from(`${SENSOR_ID}|not-a-timestamp`, 'utf8').toString('base64url');

      expect(decodeSensorReadingId(id)).toBeNull();
    });

    it('returns null when there is no separator', () => {
      const id = Buffer.from(SENSOR_ID, 'utf8').toString('base64url');

      expect(decodeSensorReadingId(id)).toBeNull();
    });

    it('returns null when a third separator-delimited part is present', () => {
      const id = Buffer.from(
        `${SENSOR_ID}|2026-07-20 12:34:56+00|extra`,
        'utf8',
      ).toString('base64url');

      expect(decodeSensorReadingId(id)).toBeNull();
    });

    it('rejects an anchor with more than microsecond precision', () => {
      const id = Buffer.from(
        `${SENSOR_ID}|2026-07-20 12:34:56.7890129+00`,
        'utf8',
      ).toString('base64url');

      expect(decodeSensorReadingId(id)).toBeNull();
    });
  });
});
