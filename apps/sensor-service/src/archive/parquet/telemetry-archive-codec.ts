/**
 * Task 6 (100-tenant readiness plan): the archive artifact codec.
 *
 * FORMAT CONTRACT (the verifier re-reads EXACTLY these bytes):
 *   Line 1 — header: {"format":"aqua-telemetry-archive/1","tenantId":…,
 *             "tenantSchema":…,"day":"YYYY-MM-DD","columns":[…],"codec":"columnar-jsonl"}
 *   Line 2..N+1 — one JSON object per raw row with FIXED key order:
 *             time, sensorId, channelId, tenantId, rawValue, value,
 *             qualityCode, qualityBits, sourceProtocol, sourceTimestamp
 *   Line N+2 — trailer: {"rowCount":N}
 * Trailing newline after every line INCLUDING the trailer. sha256 is
 * computed over the exact byte sequence.
 *
 * WHY columnar-jsonl and not Parquet YET: the plan's Step 6.3 names
 * Parquet; the parquet writer dependency could not be installed in the
 * authoring environment (registry installs hang; the two candidate
 * libraries are either dependency-heavy — @dsnp/parquetjs pulls aws-sdk/
 * brotli-wasm — or stale). The load-bearing guarantees — deterministic
 * bytes, independent re-read verification, manifest+checksum, RAW export
 * — are format-independent, so the codec is a pluggable seam
 * (`codec` is stamped in the header AND the ledger manifest). The
 * Parquet codec drops in behind this same interface on the build host;
 * switching codecs requires a NEW format version tag, never a silent
 * change to version 1 readers.
 *
 * Determinism rules that make verification byte-exact:
 *   - Rows arrive from the exporter in (time, sensor_id, channel_id)
 *     ORDER — the table's PK — and the codec preserves arrival order.
 *   - JSON.stringify with the fixed literal key order above (never a
 *     spread of a caller object).
 *   - Dates serialize as ISO-8601 UTC (toISOString is monotonic).
 */

export const ARCHIVE_FORMAT_VERSION = 'aqua-telemetry-archive/1';
export const ARCHIVE_CODEC_ID = 'columnar-jsonl';

/** Fixed column order — the ONLY key order ever written. */
const ROW_COLUMNS = [
  'time',
  'sensorId',
  'channelId',
  'tenantId',
  'rawValue',
  'value',
  'qualityCode',
  'qualityBits',
  'sourceProtocol',
  'sourceTimestamp',
] as const;

export interface ArchiveRow {
  time: string;
  sensorId: string;
  channelId: string;
  tenantId: string;
  rawValue: number;
  value: number;
  qualityCode: number;
  qualityBits: number;
  sourceProtocol: string | null;
  sourceTimestamp: string | null;
}

export interface ArchiveHeader {
  format: string;
  codec: string;
  tenantId: string;
  tenantSchema: string;
  day: string;
  columns: readonly string[];
}

/** Serialize the header line. */
export function encodeHeader(header: Omit<ArchiveHeader, 'format' | 'codec' | 'columns'>): string {
  return JSON.stringify({
    format: ARCHIVE_FORMAT_VERSION,
    codec: ARCHIVE_CODEC_ID,
    tenantId: header.tenantId,
    tenantSchema: header.tenantSchema,
    day: header.day,
    columns: ROW_COLUMNS,
  });
}

/** Serialize one row with the fixed key order. */
export function encodeRow(row: ArchiveRow): string {
  return JSON.stringify({
    time: row.time,
    sensorId: row.sensorId,
    channelId: row.channelId,
    tenantId: row.tenantId,
    rawValue: row.rawValue,
    value: row.value,
    qualityCode: row.qualityCode,
    qualityBits: row.qualityBits,
    sourceProtocol: row.sourceProtocol,
    sourceTimestamp: row.sourceTimestamp,
  });
}

/** Serialize the trailer. */
export function encodeTrailer(rowCount: number): string {
  return JSON.stringify({ rowCount });
}

/** The manifest recorded in the ledger alongside the object key. */
export interface ArchiveManifest {
  format: string;
  codec: string;
  objectKey: string;
  sourceRowCount: number;
  sourceSnapshot: string;
  sourceWalLsn: string | null;
  minTime: string | null;
  maxTime: string | null;
  sha256: string;
  bytes: number;
}
