import {
  anchorFromDatabaseText,
  anchorFromDate,
  decodeSensorReadingId,
  encodeSensorReadingId,
  sensorReadingAnchorSql,
  type SensorReadingAnchor,
} from '../sensor-reading-id.codec';

const SENSOR_ID = '550e8400-e29b-41d4-a716-446655440000';

/** Build an anchor from canonical text, failing the spec if it is not canonical. */
function anchor(text: string): SensorReadingAnchor {
  const value = anchorFromDatabaseText(text);
  if (!value) {
    throw new Error(`Not a canonical anchor: ${text}`);
  }
  return value;
}

/** Encode a raw payload the way a hand-rolled (non-codec) producer would. */
function rawId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

describe('SensorReadingIdCodec', () => {
  describe('one instant, one id', () => {
    it('mints the same anchor from a JS Date and from the database rendering of that instant', () => {
      // This is the whole point of the branded anchor: the ingest path holds a
      // Date, the read path holds what Postgres rendered for the row written
      // from that Date. Before, the two produced '2026-07-20T12:34:56.789Z' and
      // '2026-07-20 12:34:56.789+00' — one reading, two federation ids.
      const fromIngest = anchorFromDate(new Date('2026-07-20T12:34:56.789Z'));
      const fromRead = anchor('2026-07-20T12:34:56.789000Z');

      expect(fromIngest).toBe(fromRead);
      expect(encodeSensorReadingId(SENSOR_ID, fromIngest)).toBe(
        encodeSensorReadingId(SENSOR_ID, fromRead),
      );
    });

    it('renders a Date at microsecond width so it lines up with timestamptz text', () => {
      expect(anchorFromDate(new Date('2026-07-20T12:34:56.789Z'))).toBe(
        '2026-07-20T12:34:56.789000Z',
      );
    });

    it('renders a whole-second Date with explicit zero microseconds', () => {
      expect(anchorFromDate(new Date('2026-07-20T12:34:56Z'))).toBe(
        '2026-07-20T12:34:56.000000Z',
      );
    });
  });

  describe('database anchor SQL', () => {
    it('converts the column to UTC and renders the canonical shape', () => {
      // The SQL side of the same invariant: every as-of query mints its anchor
      // through this expression, so no read can drift into another spelling.
      expect(sensorReadingAnchorSql('lv.time')).toBe(
        `to_char(lv.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      );
    });
  });

  describe('round-trip', () => {
    it('preserves the sensor id and a microsecond-precision anchor', () => {
      // The load-bearing case: microsecond precision a JS Date would truncate.
      const anchorText = '2026-07-20T12:34:56.789012Z';

      const decoded = decodeSensorReadingId(encodeSensorReadingId(SENSOR_ID, anchor(anchorText)));

      expect(decoded).toEqual({ sensorId: SENSOR_ID, anchor: anchorText });
    });

    it('produces a URL-safe (base64url) id with no padding or +/ characters', () => {
      const id = encodeSensorReadingId(SENSOR_ID, anchor('2026-07-20T12:34:56.789012Z'));

      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('anchorFromDatabaseText fail-closed', () => {
    it.each([
      ['timestamptz ::text spelling (space separator, +00 offset)', '2026-07-20 12:34:56.789012+00'],
      ['millisecond-only fraction', '2026-07-20T12:34:56.789Z'],
      ['no fractional part', '2026-07-20T12:34:56Z'],
      ['non-UTC numeric offset', '2026-07-20T12:34:56.789012+03:30'],
      ['more than microsecond precision', '2026-07-20T12:34:56.7890129Z'],
      ['not a timestamp at all', 'not-a-timestamp'],
    ])('rejects %s', (_label, text) => {
      expect(anchorFromDatabaseText(text)).toBeNull();
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
      expect(decodeSensorReadingId(rawId('not-a-uuid|2026-07-20T12:34:56.000000Z'))).toBeNull();
    });

    it('returns null when the anchor is not in canonical form', () => {
      expect(
        decodeSensorReadingId(rawId(`${SENSOR_ID}|2026-07-20 12:34:56.789012+00`)),
      ).toBeNull();
    });

    it('returns null when there is no separator', () => {
      expect(decodeSensorReadingId(rawId(SENSOR_ID))).toBeNull();
    });

    it('returns null when a third separator-delimited part is present', () => {
      expect(
        decodeSensorReadingId(rawId(`${SENSOR_ID}|2026-07-20T12:34:56.000000Z|extra`)),
      ).toBeNull();
    });
  });

  describe('canonical encoding — one id per anchor', () => {
    const canonical = encodeSensorReadingId(SENSOR_ID, anchor('2026-07-20T12:34:56.789012Z'));

    it('accepts the canonical base64url encoding', () => {
      expect(decodeSensorReadingId(canonical)).not.toBeNull();
    });

    it.each([
      ['padded', `${canonical}==`],
      ['standard-alphabet', canonical.replace(/-/g, '+').replace(/_/g, '/')],
      ['whitespace-injected', `${canonical} `],
    ])('rejects the %s variant that decodes to the same payload', (_label, variant) => {
      // Node's base64 decoder is lenient, so several strings decode to one
      // payload. For a federation cache key that means one entity occupying
      // several client-store slots — so only the canonical encoding is an id.
      if (variant === canonical) {
        return;
      }
      expect(decodeSensorReadingId(variant)).toBeNull();
    });
  });
});
