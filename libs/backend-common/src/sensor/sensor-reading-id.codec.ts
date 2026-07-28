import { UUID_REGEX } from '../constants/validation-patterns';

/**
 * SensorReading federation-id codec (SENSOR-HIGH-085 / hardened-plan D3).
 *
 * A `SensorReading` is no longer a stored row — it is a CQRS as-of read
 * projection over the per-channel `sensor_metrics` source of truth (last-known
 * value per channel where `time <= T`). It therefore has no natural database
 * primary key to hand Apollo Federation's `@key(fields: "id")`. The
 * projection's identity IS its anchor: the (sensorId, as-of instant) pair the
 * snapshot was reconstructed at. This codec is the single, reversible mapping
 * between that pair and the opaque federation `id` string.
 *
 *   id = base64url("<sensorId>|<anchor>")
 *
 * `resolveReference` decodes the `id` back into (sensorId, anchor) and re-runs
 * the as-of reconstruction, so a reference minted by any read
 * (`latestReading`, `readings`, `latestReadingsBatch`) resolves to the exact
 * same snapshot.
 *
 * # The anchor is an INSTANT, not a rendering of one
 *
 * A federation id is a cache key. Apollo's gateway, every Relay/Apollo client
 * store, and every consumer that persists a reference (farm-service's
 * `related_sensor_reading_id`) treat two different `id` strings as two
 * different entities. So the id must be a function of the *instant* the
 * snapshot is anchored at — never of some textual rendering of that instant.
 *
 * That is exactly what went wrong before this type existed: the ingest path
 * minted `Date.toISOString()` (`2026-07-20T12:34:56.789Z`) while the read path
 * minted `time::text` (`2026-07-20 12:34:56.789+00`). Same instant, same
 * reading, two ids — a client that ingested a reading and then queried it back
 * got two entities in its store, and a stored reference minted by one path
 * never matched an id minted by the other.
 *
 * The fix is structural: an anchor can only be obtained from
 * {@link anchorFromDate} or {@link anchorFromDatabaseText}, both of which
 * produce ONE canonical spelling of an instant —
 *
 *   YYYY-MM-DDTHH:MM:SS.ssssssZ   (always UTC, always exactly 6 fraction digits)
 *
 * and {@link encodeSensorReadingId} accepts nothing else, because
 * {@link SensorReadingAnchor} is a branded type no plain `string` satisfies.
 * Different renderings of one instant cannot reach the encoder at all.
 *
 * # Why microsecond precision, and why the database renders it
 *
 * `sensor_metrics.time` is a Postgres `timestamptz` with MICROSECOND
 * resolution; a JS `Date` only holds milliseconds. The as-of reconstruction
 * query pins the snapshot with `time <= $anchor`. An anchor truncated to
 * millisecond precision but derived from a microsecond `MAX(time)` (e.g.
 * `…56.789012Z` truncated to `…56.789Z`) would round DOWN and the `<=` bound
 * would EXCLUDE the very row it was minted from — the freshest sample silently
 * dropping out of the reconstructed reading. So the database renders the
 * anchor itself, at full precision, via {@link sensorReadingAnchorSql}; the
 * codec never parses it into a Date, and Postgres owns the parse on both ends.
 *
 * # Fail-closed decode
 *
 * `decode` returns `null` for anything that is not a canonical id: wrong part
 * count, non-UUID sensor id, non-canonical anchor spelling, or a base64url
 * body that is not the exact canonical encoding of its own payload. A
 * federation reference that fails to decode resolves to `null`
 * (entity-not-found) — never a query with attacker-influenced text, and never
 * two distinct id strings collapsing onto one entity.
 */

/**
 * The canonical spelling of an as-of instant: UTC, ISO-8601, exactly six
 * fractional-second digits, `Z` offset. Branded so it cannot be produced by
 * hand — the only constructors are {@link anchorFromDate} and
 * {@link anchorFromDatabaseText}, which is what makes "one instant, one id"
 * a compile-time property rather than a convention.
 */
export type SensorReadingAnchor = string & { readonly __brand: unique symbol };

/** The (sensorId, as-of anchor) pair a SensorReading `id` encodes. */
export interface DecodedSensorReadingId {
  /** The sensor whose channels the snapshot was reconstructed from. */
  readonly sensorId: string;
  /**
   * Canonical UTC anchor of the as-of instant, fed back verbatim as a
   * `$n::timestamptz` bound parameter. NEVER parsed into a Date.
   */
  readonly anchor: SensorReadingAnchor;
}

/** Field separator — neither a UUID nor a canonical anchor can contain it. */
const ID_SEPARATOR = '|';

/**
 * The one accepted anchor spelling. Matches, byte for byte, both what
 * {@link sensorReadingAnchorSql} makes Postgres emit and what
 * {@link anchorFromDate} builds from a JS `Date`.
 */
const CANONICAL_ANCHOR_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Postgres `to_char` template producing {@link CANONICAL_ANCHOR_REGEX} output:
 * the column converted to UTC, ISO-8601 `T` separator, `.US` microseconds, and
 * a literal `Z`.
 */
const ANCHOR_TO_CHAR_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * SQL that renders a `timestamptz` column as a canonical anchor.
 *
 * Every as-of query mints its anchor through this one expression, so no read
 * path can drift into a different spelling — the property the branded type
 * enforces on the TypeScript side, enforced on the SQL side.
 *
 * @param column A `timestamptz` column reference (e.g. `lv.time`). This is a
 *   SQL identifier the caller writes into its own query text, never user input.
 */
export function sensorReadingAnchorSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', '${ANCHOR_TO_CHAR_FORMAT}')`;
}

/**
 * Canonical anchor for an instant held as a JS `Date` (the ingest path, whose
 * observation timestamp is a `Date` before it is ever written).
 *
 * `Date` carries millisecond resolution, so the microsecond digits are zero —
 * which is exactly what Postgres stores for a row written from that `Date`,
 * and therefore exactly what the read path renders back.
 */
export function anchorFromDate(instant: Date): SensorReadingAnchor {
  // toISOString() is always `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, 3 fraction
  // digits); widening the fraction to 6 digits is the whole conversion — no
  // reformatting, no offset arithmetic, no parse.
  return `${instant.toISOString().slice(0, -1)}000Z` as SensorReadingAnchor;
}

/**
 * Canonical anchor for text rendered by {@link sensorReadingAnchorSql}, or
 * `null` when the text is not in canonical form (fail-closed).
 */
export function anchorFromDatabaseText(text: string): SensorReadingAnchor | null {
  if (typeof text !== 'string' || !CANONICAL_ANCHOR_REGEX.test(text)) {
    return null;
  }
  return text as SensorReadingAnchor;
}

/**
 * Encode a SensorReading federation id from its as-of anchor.
 *
 * @param sensorId Sensor UUID the snapshot belongs to.
 * @param anchor Canonical anchor from {@link anchorFromDate} or
 *   {@link anchorFromDatabaseText}. A plain `string` does not type-check.
 */
export function encodeSensorReadingId(sensorId: string, anchor: SensorReadingAnchor): string {
  return Buffer.from(`${sensorId}${ID_SEPARATOR}${anchor}`, 'utf8').toString('base64url');
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

  // Node's base64 decoder is deliberately lenient: it accepts padding,
  // standard-alphabet `+`/`/`, embedded whitespace and truncated tails, so
  // MANY distinct id strings decode to one payload. For a federation cache key
  // that is a correctness bug, not just laxity — the same entity would occupy
  // several client-store slots. Requiring the input to be its payload's own
  // canonical encoding admits exactly one id per (sensorId, anchor) pair.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== id) {
    return null;
  }

  const separatorIndex = decoded.indexOf(ID_SEPARATOR);
  if (separatorIndex < 0) {
    return null;
  }

  const sensorId = decoded.slice(0, separatorIndex);
  const anchorText = decoded.slice(separatorIndex + 1);

  // Exactly two parts: a trailing separator (or one inside the anchor, which is
  // impossible for a canonical anchor) leaves a stray separator behind.
  if (anchorText.includes(ID_SEPARATOR)) {
    return null;
  }
  if (!UUID_REGEX.test(sensorId)) {
    return null;
  }

  const anchor = anchorFromDatabaseText(anchorText);
  if (!anchor) {
    return null;
  }

  return { sensorId, anchor };
}
