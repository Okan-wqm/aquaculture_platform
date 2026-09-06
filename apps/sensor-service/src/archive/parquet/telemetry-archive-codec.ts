import { ParquetReader, ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Task 6 (100-tenant readiness plan): the archive artifact codec.
 *
 * TWO FORMAT VERSIONS LIVE HERE, and that is deliberate.
 *
 * `aqua-telemetry-archive/2` (codec `parquet`) is what the exporter WRITES.
 * It is real columnar Parquet: a typed schema, `PAR1` magic at both ends of
 * the file, the archive header carried in the file's own key-value metadata,
 * and a decoder that reads rows back as `ArchiveRow` values rather than as
 * text. The verifier round-trips every row through it, so a file that hashes
 * correctly but decodes to something else cannot pass.
 *
 * `aqua-telemetry-archive/1` (codec `columnar-jsonl`) is what earlier exports
 * WROTE, and its encoder stays here byte-for-byte. Objects already in a
 * tenant's bucket carry it, and their ledger rows carry a sha256 over exactly
 * those bytes; a version-1 reader must keep working unchanged or every
 * previously VERIFIED artifact silently becomes unverifiable. The version tag
 * is what makes the two safe to coexist — a reader picks its parse by what the
 * bytes say they are, never by what the newest exporter happens to write.
 *
 * SENSOR-HIGH-105 closed here: the merged v3 codec named itself Parquet at
 * every level except the bytes, because the writer dependency could not be
 * installed when it was written. `@dsnp/parquetjs` is now a declared
 * dependency, so the name and the format agree.
 *
 * Ordering: rows arrive from the exporter in `(time, sensor_id, channel_id)`
 * order — the hypertable's PK — and both codecs preserve arrival order, so the
 * verifier can assert the stored file is still in that order.
 */

/** Version 1 — the columnar-JSONL artifacts already in tenant buckets. */
export const ARCHIVE_FORMAT_VERSION = 'aqua-telemetry-archive/1';
export const ARCHIVE_CODEC_ID = 'columnar-jsonl';

/** Version 2 — real Parquet; what every new export writes. */
export const ARCHIVE_FORMAT_VERSION_V2 = 'aqua-telemetry-archive/2';
export const ARCHIVE_CODEC_ID_V2 = 'parquet';

/** File extension of a version-2 artifact, and the Parquet file magic. */
export const ARCHIVE_FILE_EXTENSION_V2 = 'parquet';
const PARQUET_MAGIC = 'PAR1';

/** One row group per 8 192 rows — small enough that a partial read is cheap. */
const PARQUET_ROW_GROUP_SIZE = 8_192;

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

/**
 * The archive header, carried in the Parquet file's key-value metadata for
 * version 2 and on the first JSONL line for version 1. Every key is prefixed
 * so a future writer cannot collide with a library-owned metadata key.
 */
const METADATA_KEY = {
  format: 'aqua.telemetry.format',
  codec: 'aqua.telemetry.codec',
  tenantId: 'aqua.telemetry.tenant-id',
  tenantSchema: 'aqua.telemetry.tenant-schema',
  day: 'aqua.telemetry.day',
  columns: 'aqua.telemetry.columns',
} as const;

const ARCHIVE_PARQUET_SCHEMA = new ParquetSchema({
  time: { type: 'UTF8' },
  sensorId: { type: 'UTF8' },
  channelId: { type: 'UTF8' },
  tenantId: { type: 'UTF8' },
  rawValue: { type: 'DOUBLE' },
  value: { type: 'DOUBLE' },
  qualityCode: { type: 'INT32' },
  qualityBits: { type: 'INT32' },
  sourceProtocol: { type: 'UTF8', optional: true },
  sourceTimestamp: { type: 'UTF8', optional: true },
});

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

/** The tenant/day identity an encoder is given; format and codec are ours. */
export type ArchiveIdentity = Omit<ArchiveHeader, 'format' | 'codec' | 'columns'>;

// ---------------------------------------------------------------------------
// Version 1 — columnar JSONL. Encoder frozen; readers must keep working.
// ---------------------------------------------------------------------------

/** Serialize the version-1 header line. */
export function encodeHeader(header: ArchiveIdentity): string {
  return JSON.stringify({
    format: ARCHIVE_FORMAT_VERSION,
    codec: ARCHIVE_CODEC_ID,
    tenantId: header.tenantId,
    tenantSchema: header.tenantSchema,
    day: header.day,
    columns: ROW_COLUMNS,
  });
}

/** Serialize one version-1 row with the fixed key order. */
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

/** Serialize the version-1 trailer. */
export function encodeTrailer(rowCount: number): string {
  return JSON.stringify({ rowCount });
}

// ---------------------------------------------------------------------------
// Version 2 — Parquet.
// ---------------------------------------------------------------------------

/** What one encode pass produced. */
export interface EncodedArchive {
  bytes: Buffer;
  rowCount: number;
  minTime: string | null;
  maxTime: string | null;
  sha256: string;
}

/** What a decode pass read back out of stored bytes. */
export interface DecodedArchive {
  header: ArchiveHeader;
  rows: ArchiveRow[];
  minTime: string | null;
  maxTime: string | null;
}

/** True when the stored bytes are a Parquet file (magic at both ends). */
export function isParquetArchive(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes.subarray(0, 4).toString('ascii') === PARQUET_MAGIC &&
    bytes.subarray(bytes.length - 4).toString('ascii') === PARQUET_MAGIC
  );
}

/**
 * Encode one tenant-day as a version-2 Parquet artifact.
 *
 * The writer is file-backed because that is the only sink `@dsnp/parquetjs`
 * offers without reaching into its stream internals; the file lives in a
 * private scratch directory that is removed on every exit path, and the bytes
 * the caller uploads are read back from it, so the sha256 is over exactly what
 * lands in object storage.
 */
export async function encodeParquetArchive(
  identity: ArchiveIdentity,
  rows: AsyncIterable<ArchiveRow>,
): Promise<EncodedArchive> {
  const directory = await mkdtemp(join(tmpdir(), 'aqua-telemetry-archive-'));
  const path = join(directory, `${randomUUID()}.${ARCHIVE_FILE_EXTENSION_V2}`);
  try {
    const writer = await ParquetWriter.openFile(ARCHIVE_PARQUET_SCHEMA, path);
    writer.setRowGroupSize(PARQUET_ROW_GROUP_SIZE);
    writer.setMetadata(METADATA_KEY.format, ARCHIVE_FORMAT_VERSION_V2);
    writer.setMetadata(METADATA_KEY.codec, ARCHIVE_CODEC_ID_V2);
    writer.setMetadata(METADATA_KEY.tenantId, identity.tenantId);
    writer.setMetadata(METADATA_KEY.tenantSchema, identity.tenantSchema);
    writer.setMetadata(METADATA_KEY.day, identity.day);
    writer.setMetadata(METADATA_KEY.columns, JSON.stringify(ROW_COLUMNS));

    let rowCount = 0;
    let minTime: string | null = null;
    let maxTime: string | null = null;
    for await (const row of rows) {
      assertArchiveRow(row);
      await writer.appendRow(toParquetRecord(row));
      minTime = earlier(minTime, row.time);
      maxTime = later(maxTime, row.time);
      rowCount += 1;
    }
    await writer.close();

    const bytes = await readFile(path);
    return {
      bytes,
      rowCount,
      minTime,
      maxTime,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Decode a version-2 artifact back into typed rows and its header.
 *
 * Throws on anything that is not a well-formed version-2 archive: wrong magic,
 * missing or unexpected metadata, a column the schema does not carry, or a row
 * whose values do not satisfy the same assertions the encoder applied. The
 * verifier turns every one of those into a FAILED ledger event.
 */
export async function decodeParquetArchive(bytes: Buffer): Promise<DecodedArchive> {
  if (!isParquetArchive(bytes)) {
    throw new Error('Telemetry archive object is not a Parquet file');
  }
  const reader = await ParquetReader.openBuffer(bytes);
  try {
    const header = readHeader(reader.getMetadata());
    const rows: ArchiveRow[] = [];
    let minTime: string | null = null;
    let maxTime: string | null = null;
    const records: AsyncIterable<unknown> = reader;
    for await (const record of records) {
      const row = fromParquetRecord(record);
      rows.push(row);
      minTime = earlier(minTime, row.time);
      maxTime = later(maxTime, row.time);
    }
    return { header, rows, minTime, maxTime };
  } finally {
    await reader.close();
  }
}

function readHeader(metadata: Record<string, unknown>): ArchiveHeader {
  const format = metadataString(metadata, METADATA_KEY.format);
  if (format !== ARCHIVE_FORMAT_VERSION_V2) {
    throw new Error(`Telemetry archive format ${JSON.stringify(format)} is not readable here`);
  }
  const codec = metadataString(metadata, METADATA_KEY.codec);
  if (codec !== ARCHIVE_CODEC_ID_V2) {
    throw new Error(`Telemetry archive codec ${JSON.stringify(codec)} is not readable here`);
  }
  const columns: unknown = JSON.parse(metadataString(metadata, METADATA_KEY.columns));
  if (!Array.isArray(columns) || columns.join(',') !== ROW_COLUMNS.join(',')) {
    throw new Error('Telemetry archive column set does not match the version-2 schema');
  }
  return {
    format,
    codec,
    tenantId: metadataString(metadata, METADATA_KEY.tenantId),
    tenantSchema: metadataString(metadata, METADATA_KEY.tenantSchema),
    day: metadataString(metadata, METADATA_KEY.day),
    columns: ROW_COLUMNS,
  };
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Telemetry archive metadata ${key} is missing`);
  }
  return value;
}

function toParquetRecord(row: ArchiveRow): Record<string, unknown> {
  const record: Record<string, unknown> = {
    time: row.time,
    sensorId: row.sensorId,
    channelId: row.channelId,
    tenantId: row.tenantId,
    rawValue: row.rawValue,
    value: row.value,
    qualityCode: row.qualityCode,
    qualityBits: row.qualityBits,
  };
  // An optional Parquet column is absent, not null: writing an explicit null
  // makes the writer emit a defined value with no payload.
  if (row.sourceProtocol !== null) record['sourceProtocol'] = row.sourceProtocol;
  if (row.sourceTimestamp !== null) record['sourceTimestamp'] = row.sourceTimestamp;
  return record;
}

function fromParquetRecord(value: unknown): ArchiveRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Telemetry archive row is not an object');
  }
  const record: Record<string, unknown> = { ...value };
  const row: ArchiveRow = {
    time: requiredString(record, 'time'),
    sensorId: requiredString(record, 'sensorId'),
    channelId: requiredString(record, 'channelId'),
    tenantId: requiredString(record, 'tenantId'),
    rawValue: requiredNumber(record, 'rawValue'),
    value: requiredNumber(record, 'value'),
    qualityCode: requiredInteger(record, 'qualityCode'),
    qualityBits: requiredInteger(record, 'qualityBits'),
    sourceProtocol: optionalString(record, 'sourceProtocol'),
    sourceTimestamp: optionalString(record, 'sourceTimestamp'),
  };
  assertArchiveRow(row);
  return row;
}

/**
 * The same assertions on the way in and on the way out. A value the encoder
 * would have refused must not be readable back as valid either — otherwise a
 * hand-built object could decode into a row the platform never could produce.
 */
function assertArchiveRow(row: ArchiveRow): void {
  const timestamp = new Date(row.time);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== row.time) {
    throw new Error('Telemetry archive row time must be a canonical ISO-8601 timestamp');
  }
  if (!Number.isFinite(row.rawValue) || !Number.isFinite(row.value)) {
    throw new Error('Telemetry archive values must be finite numbers');
  }
  if (!Number.isInteger(row.qualityCode) || !Number.isInteger(row.qualityBits)) {
    throw new Error('Telemetry archive quality values must be integers');
  }
}

/** Running min/max over the archived instants; ISO-8601 UTC sorts as text. */
function earlier(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Telemetry archive field ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Telemetry archive field ${field} must be a string or null`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Telemetry archive field ${field} must be a finite number`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, field: string): number {
  const value = requiredNumber(record, field);
  if (!Number.isInteger(value)) {
    throw new Error(`Telemetry archive field ${field} must be an integer`);
  }
  return value;
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
