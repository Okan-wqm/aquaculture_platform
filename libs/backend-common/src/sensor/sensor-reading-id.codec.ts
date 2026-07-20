import { UUID_REGEX } from '../constants/validation-patterns';

/**
 * SensorReading federation-id codec (SENSOR-HIGH-085 / hardened-plan D3).
 *
 * A `SensorReading` is no longer a stored row — it is a CQRS as-of read
 * projection over the per-channel `sensor.sensor_metrics` source of truth
 * (last-known value per channel where `time <= T`). It therefore has no
 * natural database primary key to hand Apollo Federation's `@key(fields: "id")`.
 * The projection's identity IS its anchor: the (sensorId, as-of instant) pair
 * the snapshot was reconstructed at. This codec is the single, reversible
 * mapping between that pair and the opaque federation `id` string.
 *
 *   id = base64url("<sensorId>|<timeText>")
 *
 * `resolveReference` decodes the `id` back into (sensorId, timeText) and
 * re-runs the as-of reconstruction, so a reference minted by any read
 * (`latestReading`, `readings`, `latestReadingsBatch`) resolves to the exact
 * same snapshot.
 *
 * WHY the anchor is carried as full-precision timestamptz TEXT, not a JS Date
 * / `Date.toISOString()`:
 *   `sensor_metrics.time` is a Postgres `timestamptz` with MICROSECOND
 *   resolution; a JS `Date` only holds milliseconds. The as-of reconstruction
 *   query pins the snapshot with `time <= $anchor`. If the anchor were
 *   truncated to millisecond precision, an anchor derived from a microsecond
 *   `MAX(time)` (e.g. `...56.789012+00`) would round DOWN to `...56.789+00`
 *   and the `<=` bound would EXCLUDE the very row it was minted from — the
 *   freshest sample silently drops out of the reconstructed reading. Carrying
 *   the exact `MAX(time)::text` and feeding it straight back as a bound
 *   `$n::timestamptz` parameter round-trips losslessly. The codec never parses
 *   the text into a Date; Postgres owns the parse on both write and read.
 *
 * Fail-closed: `decode` returns `null` for anything that is not a canonical,
 * structurally-valid id (wrong part count, non-UUID sensor id, non-timestamptz
 * anchor). A federation reference that fails to decode resolves to `null`
 * (entity-not-found) — never a query with attacker-influenced text.
 */

/** The (sensorId, as-of anchor) pair a SensorReading `id` encodes. */
export interface DecodedSensorReadingId {
  /** The sensor whose channels the snapshot was reconstructed from. */
  readonly sensorId: string;
  /**
   * Full-precision Postgres `timestamptz` text of the as-of instant, fed back
   * verbatim as a `$n::timestamptz` bound parameter. NEVER parsed into a Date.
   */
  readonly timeText: string;
}

/** Field separator — neither a UUID nor timestamptz text can contain it. */
const ID_SEPARATOR = '|';

/**
 * Postgres `timestamptz::text` and ISO-8601 shapes, with up to microsecond
 * fractional precision and a numeric or `Z` offset:
 *   2026-07-20 12:34:56.789012+00 · 2026-07-20T12:34:56Z · 2026-07-20 12:34:56+03:30
 */
const TIMESTAMPTZ_TEXT_REGEX =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

/**
 * Encode a SensorReading federation id from its as-of anchor.
 *
 * @param sensorId Sensor UUID the snapshot belongs to.
 * @param timeText Full-precision `timestamptz` text of the as-of instant
 *   (from `MAX(time)::text` / `<observation time>::text` — NOT `Date.toISOString()`).
 */
export function encodeSensorReadingId(sensorId: string, timeText: string): string {
  return Buffer.from(`${sensorId}${ID_SEPARATOR}${timeText}`, 'utf8').toString('base64url');
}

/**
 * Decode a SensorReading federation id back into its as-of anchor, or `null`
 * when the id is not a canonical, structurally-valid encoding (fail-closed).
 */
export function decodeSensorReadingId(id: string): DecodedSensorReadingId | null {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(ID_SEPARATOR);
  if (separatorIndex < 0) {
    return null;
  }

  const sensorId = decoded.slice(0, separatorIndex);
  const timeText = decoded.slice(separatorIndex + 1);

  // Exactly two parts: a trailing separator (or one inside timeText, which is
  // impossible for valid timestamptz text) leaves a stray separator behind.
  if (timeText.includes(ID_SEPARATOR)) {
    return null;
  }
  if (!UUID_REGEX.test(sensorId)) {
    return null;
  }
  if (!TIMESTAMPTZ_TEXT_REGEX.test(timeText)) {
    return null;
  }

  return { sensorId, timeText };
}
