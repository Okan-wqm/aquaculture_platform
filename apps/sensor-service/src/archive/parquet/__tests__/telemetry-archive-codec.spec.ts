import { stub, stubMember } from '@aquaculture/testing';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../../telemetry-retention-orchestrator.service';
import {
  ARCHIVE_CODEC_ID_V2,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_FORMAT_VERSION_V2,
  type ArchiveRow,
  decodeParquetArchive,
  encodeHeader,
  encodeParquetArchive,
  encodeRow,
  encodeTrailer,
  isParquetArchive,
} from '../telemetry-archive-codec';
import { TelemetryParquetExporterService } from '../telemetry-parquet-exporter.service';
import { TelemetryParquetVerifierService } from '../telemetry-parquet-verifier.service';

/**
 * Task 6 (SENSOR-HIGH-095 / SENSOR-HIGH-105): the export→verify chain over the
 * Task 4 ledger, now writing real Parquet.
 *
 * The exporter snapshots with REPEATABLE READ + CSN/LSN provenance, streams the
 * day into a version-2 Parquet artifact and appends EXPORT_STARTED→EXPORTED;
 * the INDEPENDENT verifier re-reads the stored bytes, decodes every row back
 * through the codec, and only exact equality appends VERIFIED. The version-1
 * columnar-JSONL path stays covered because objects written before the codec
 * change are still in tenant buckets.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const SCHEMA = 'tenant_1111111111114111';
const DAY = '2026-07-01';
const FIRST = '2026-07-01T00:00:00.000Z';
const SECOND = '2026-07-01T00:01:00.000Z';

function row(time: string): ArchiveRow {
  return {
    time,
    sensorId: '22222222-2222-4222-8222-222222222222',
    channelId: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    rawValue: 24.5,
    value: 24.5,
    qualityCode: 192,
    qualityBits: 0,
    sourceProtocol: 'mqtt',
    sourceTimestamp: time,
  };
}

async function* rowStream(rows: readonly ArchiveRow[]): AsyncGenerator<ArchiveRow> {
  for (const value of rows) yield value;
}

interface UploadedObject {
  tenantId: string;
  entityType: string;
  entityId: string;
  filename: string;
  buffer: Buffer;
}

interface Harness {
  exporter: TelemetryParquetExporterService;
  verifier: TelemetryParquetVerifierService;
  transaction: jest.Mock;
  queries: Array<{ sql: string; params: unknown[] }>;
  uploaded: UploadedObject[];
  ledgerEvents: Array<Record<string, unknown>>;
  setObject(bytes: Buffer): void;
}

function makeHarness(): Harness {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const uploaded: UploadedObject[] = [];
  const ledgerEvents: Array<Record<string, unknown>> = [];
  let storedBytes: Buffer | null = null;

  // The driver hands timestamptz back as Date; the exporter is what normalizes
  // it to canonical ISO-8601, so the fixture must not pre-normalize it.
  const sourceRows = [
    { time: new Date(FIRST), sourceTimestamp: new Date(FIRST) },
    { time: new Date(SECOND), sourceTimestamp: new Date(SECOND) },
  ];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params ?? [] });
    if (sql.includes('txid_current_snapshot')) {
      return [{ snapshot: '100:105:100,104', lsn: '0/1A2B3C4' }];
    }
    if (sql.includes('COUNT(*)')) {
      return [
        {
          count: sourceRows.length,
          min: sourceRows[0]!.time,
          max: sourceRows[sourceRows.length - 1]!.time,
        },
      ];
    }
    if (sql.includes('ORDER BY time')) {
      const offset = Number(params?.[3] ?? 0);
      return sourceRows.slice(offset).map((source) => ({
        time: source.time,
        sensorId: '22222222-2222-4222-8222-222222222222',
        channelId: '33333333-3333-4333-8333-333333333333',
        tenantId: TENANT,
        rawValue: 24.5,
        value: 24.5,
        qualityCode: 192,
        qualityBits: 0,
        sourceProtocol: 'mqtt',
        sourceTimestamp: source.sourceTimestamp,
      }));
    }
    return [];
  });
  // EntityManager.query is generic, so it needs the single-member double.
  const manager = stub<EntityManager>({ query: stubMember<EntityManager['query']>(query) });

  // TypeORM's transaction() is an overload set; the exporter uses the
  // (isolationLevel, runInTransaction) form.
  const transaction = jest.fn(async (...args: unknown[]): Promise<unknown> => {
    const runInTransaction = (typeof args[0] === 'function' ? args[0] : args[1]) as (
      entityManager: EntityManager,
    ) => Promise<unknown>;
    return runInTransaction(manager);
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(transaction),
  });

  const storage = stub<MinioClientService>({
    generateFilePath: (tenantId: string, entityType: string, entityId: string, filename: string) =>
      `${tenantId}/${entityType}/${entityId}/${filename}`,
    uploadFile: async (
      tenantId: string,
      entityType: string,
      entityId: string,
      filename: string,
      buffer: Buffer,
    ) => {
      uploaded.push({ tenantId, entityType, entityId, filename, buffer });
      storedBytes = buffer;
      return {
        internalUrl: `http://minio/${tenantId}/${entityType}/${entityId}/${filename}`,
        path: `${tenantId}/${entityType}/${entityId}/${filename}`,
        etag: 'etag',
        size: buffer.length,
        contentType: 'application/vnd.apache.parquet',
      };
    },
    downloadFile: async () => {
      if (!storedBytes) throw new Error('object not found');
      return storedBytes;
    },
  });

  const ledger = stub<TelemetryRetentionOrchestratorService>({
    append: jest.fn(async (event: Record<string, unknown>) => {
      ledgerEvents.push(event);
    }),
  });

  const exporter = new TelemetryParquetExporterService(dataSource, storage, ledger);
  const verifier = new TelemetryParquetVerifierService(storage, ledger);
  return {
    exporter,
    verifier,
    transaction,
    queries,
    uploaded,
    ledgerEvents,
    setObject: (bytes) => {
      storedBytes = bytes;
    },
  };
}

function operationFrom(harness: Harness): {
  operationId: string;
  tenantId: string;
  rangeStart: Date;
  rangeEnd: Date;
  objectKey: string;
  parquetSha256: string;
  sourceRowCount: string;
} {
  const exported = harness.ledgerEvents[1]!;
  return {
    operationId: String(exported['operationId']),
    tenantId: TENANT,
    rangeStart: new Date(`${DAY}T00:00:00.000Z`),
    rangeEnd: new Date(`${DAY}T00:00:00.000Z`),
    objectKey: String(exported['objectKey']),
    parquetSha256: String(exported['parquetSha256']),
    sourceRowCount: String(exported['sourceRowCount']),
  };
}

/** Rebuild a version-1 artifact so the legacy read path stays covered. */
function columnarJsonlArtifact(rows: readonly ArchiveRow[]): Buffer {
  const parts = [encodeHeader({ tenantId: TENANT, tenantSchema: SCHEMA, day: DAY }), '\n'];
  for (const value of rows) parts.push(encodeRow(value), '\n');
  parts.push(encodeTrailer(rows.length), '\n');
  return Buffer.from(parts.join(''), 'utf8');
}

describe('telemetry archive codec — version 2 (Parquet)', () => {
  it('writes a real Parquet file and reads every row back typed', async () => {
    const rows = [row(FIRST), row(SECOND)];
    const encoded = await encodeParquetArchive(
      { tenantId: TENANT, tenantSchema: SCHEMA, day: DAY },
      rowStream(rows),
    );

    expect(isParquetArchive(encoded.bytes)).toBe(true);
    expect(encoded.bytes.subarray(0, 4).toString('ascii')).toBe('PAR1');
    expect(encoded.rowCount).toBe(2);
    expect(encoded.minTime).toBe(FIRST);
    expect(encoded.maxTime).toBe(SECOND);
    expect(encoded.sha256).toMatch(/^[0-9a-f]{64}$/);

    const decoded = await decodeParquetArchive(encoded.bytes);
    expect(decoded.header.format).toBe(ARCHIVE_FORMAT_VERSION_V2);
    expect(decoded.header.codec).toBe(ARCHIVE_CODEC_ID_V2);
    expect(decoded.header.tenantId).toBe(TENANT);
    expect(decoded.header.tenantSchema).toBe(SCHEMA);
    expect(decoded.header.day).toBe(DAY);
    expect(decoded.rows).toEqual(rows);
  });

  it('carries a null optional column through the round trip as null', async () => {
    const sparse: ArchiveRow = { ...row(FIRST), sourceProtocol: null, sourceTimestamp: null };
    const encoded = await encodeParquetArchive(
      { tenantId: TENANT, tenantSchema: SCHEMA, day: DAY },
      rowStream([sparse]),
    );

    const decoded = await decodeParquetArchive(encoded.bytes);
    expect(decoded.rows).toEqual([sparse]);
  });

  it('refuses a row whose time is not a canonical ISO-8601 instant', async () => {
    await expect(
      encodeParquetArchive(
        { tenantId: TENANT, tenantSchema: SCHEMA, day: DAY },
        rowStream([{ ...row(FIRST), time: '2026-07-01 00:00:00+00' }]),
      ),
    ).rejects.toThrow(/canonical ISO-8601/);
  });

  it('refuses bytes that are not a Parquet file', async () => {
    await expect(decodeParquetArchive(Buffer.from('not parquet at all'))).rejects.toThrow(
      /not a Parquet file/,
    );
    expect(isParquetArchive(columnarJsonlArtifact([row(FIRST)]))).toBe(false);
  });
});

describe('TelemetryParquetExporterService (Task 6)', () => {
  it('snapshots under REPEATABLE READ with CSN+LSN provenance', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);

    expect(harness.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    expect(harness.queries.some((q) => q.sql.includes('txid_current_snapshot()'))).toBe(true);
    expect(harness.queries.some((q) => q.sql.includes('pg_current_wal_lsn()'))).toBe(true);
  });

  it('streams rows in PK order and appends EXPORT_STARTED then EXPORTED with the manifest', async () => {
    const harness = makeHarness();
    const manifest = await harness.exporter.exportTenantDay(TENANT, DAY);

    expect(
      harness.queries.some((q) => q.sql.includes('ORDER BY time, sensor_id, channel_id')),
    ).toBe(true);
    expect(manifest.format).toBe(ARCHIVE_FORMAT_VERSION_V2);
    expect(manifest.codec).toBe(ARCHIVE_CODEC_ID_V2);
    expect(manifest.sourceRowCount).toBe(2);
    expect(manifest.sourceSnapshot).toBe('100:105:100,104');
    expect(manifest.sourceWalLsn).toBe('0/1A2B3C4');
    expect(manifest.minTime).toBe(FIRST);
    expect(manifest.maxTime).toBe(SECOND);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(harness.ledgerEvents.map((event) => event['state'])).toEqual([
      'EXPORT_STARTED',
      'EXPORTED',
    ]);
    const exported = harness.ledgerEvents[1]!;
    expect(exported['parquetSha256']).toBe(manifest.sha256);
    expect(exported['tenantSchema']).toBe(SCHEMA);
    expect(harness.uploaded).toHaveLength(1);
    expect(harness.uploaded[0]!.entityType).toBe('telemetry-archive');
    expect(harness.uploaded[0]!.filename).toBe(`raw.${DAY}.parquet`);
    expect(isParquetArchive(harness.uploaded[0]!.buffer)).toBe(true);
  });

  it('normalizes driver timestamps to canonical ISO-8601 in the stored artifact', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);

    const decoded = await decodeParquetArchive(harness.uploaded[0]!.buffer);
    expect(decoded.rows.map((value) => value.time)).toEqual([FIRST, SECOND]);
    expect(decoded.rows.map((value) => value.sourceTimestamp)).toEqual([FIRST, SECOND]);
  });
});

describe('TelemetryParquetVerifierService (Task 6) — independent verify', () => {
  it('appends VERIFIED only after decoding the stored Parquet row by row', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);
    const result = await harness.verifier.verifyOperation(operationFrom(harness));

    expect(result).toBe('VERIFIED');
    expect(harness.ledgerEvents.map((event) => event['state'])).toEqual([
      'EXPORT_STARTED',
      'EXPORTED',
      'VERIFIED',
    ]);
  });

  it('a corrupted object (sha mismatch) appends FAILED, never VERIFIED', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);
    const tampered = { ...operationFrom(harness), parquetSha256: '0'.repeat(64) };
    const result = await harness.verifier.verifyOperation(tampered);

    expect(result).toBe('FAILED');
    expect(harness.ledgerEvents.map((event) => event['state'])).toEqual([
      'EXPORT_STARTED',
      'EXPORTED',
      'FAILED',
    ]);
  });

  it('a manifest claiming a different row count than the artifact fails', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);
    const lying = { ...operationFrom(harness), sourceRowCount: '999' };

    expect(await harness.verifier.verifyOperation(lying)).toBe('FAILED');
  });

  it('an object that hashes correctly but is not decodable Parquet fails', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);
    const operation = operationFrom(harness);
    // Keep the magic bytes, destroy the footer the reader needs.
    const stored = Buffer.concat([Buffer.from('PAR1'), Buffer.alloc(64, 0), Buffer.from('PAR1')]);
    harness.setObject(stored);
    const sha256 = createHash('sha256').update(stored).digest('hex');

    const result = await harness.verifier.verifyOperation({ ...operation, parquetSha256: sha256 });

    expect(result).toBe('FAILED');
  });

  it('still verifies a version-1 columnar-JSONL object already in the bucket', async () => {
    const harness = makeHarness();
    await harness.exporter.exportTenantDay(TENANT, DAY);
    const operation = operationFrom(harness);
    const legacy = columnarJsonlArtifact([row(FIRST), row(SECOND)]);
    harness.setObject(legacy);

    const result = await harness.verifier.verifyOperation({
      ...operation,
      parquetSha256: createHash('sha256').update(legacy).digest('hex'),
      sourceRowCount: '2',
    });

    expect(result).toBe('VERIFIED');
    expect(JSON.parse(legacy.toString('utf8').split('\n')[0]!)['format']).toBe(
      ARCHIVE_FORMAT_VERSION,
    );
  });
});
