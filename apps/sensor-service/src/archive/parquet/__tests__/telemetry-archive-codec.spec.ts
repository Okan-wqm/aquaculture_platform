import { createHash } from 'node:crypto';

import { DataSource } from 'typeorm';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../../telemetry-retention-orchestrator.service';
import {
  encodeHeader,
  encodeRow,
  encodeTrailer,
  type ArchiveRow,
} from '../telemetry-archive-codec';
import { TelemetryParquetExporterService } from '../telemetry-parquet-exporter.service';
import { TelemetryParquetVerifierService } from '../telemetry-parquet-verifier.service';

/**
 * Task 6 (SENSOR-HIGH-095): the export→verify chain over the Task 4
 * ledger. The exporter snapshots with REPEATABLE READ + CSN/LSN
 * provenance, uploads the deterministic artifact, and appends
 * EXPORT_STARTED→EXPORTED; the INDEPENDENT verifier re-reads the bytes and
 * only exact equality appends VERIFIED.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const SCHEMA = 'tenant_1111111111114111';
const DAY = '2026-07-01';

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

interface Harness {
  exporter: TelemetryParquetExporterService;
  verifier: TelemetryParquetVerifierService;
  txMock: jest.Mock;
  queries: Array<{ sql: string; params: unknown[] }>;
  uploaded: Array<{ tenantId: string; entityType: string; entityId: string; filename: string; buffer: Buffer }>;
  ledgerEvents: Array<Record<string, unknown>>;
  setObject(bytes: Buffer): void;
}

function makeHarness(): Harness {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const uploaded: Array<{ tenantId: string; entityType: string; entityId: string; filename: string; buffer: Buffer }> = [];
  const ledgerEvents: Array<Record<string, unknown>> = [];
  let storedBytes: Buffer | null = null;

  const rows = [row('2026-07-01T00:00:00.000Z'), row('2026-07-01T00:01:00.000Z')];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params ?? [] });
    if (sql.includes('txid_current_snapshot')) {
      return [{ snapshot: '100:105:100,104', lsn: '0/1A2B3C4' }];
    }
    if (sql.includes('COUNT(*)')) {
      return [{ count: rows.length, min: rows[0]!.time, max: rows[1]!.time }];
    }
    if (sql.includes('ORDER BY time')) {
      return rows.map((r) => ({
        time: r.time,
        sensorId: r.sensorId,
        channelId: r.channelId,
        tenantId: r.tenantId,
        rawValue: r.rawValue,
        value: r.value,
        qualityCode: r.qualityCode,
        qualityBits: r.qualityBits,
        sourceProtocol: r.sourceProtocol,
        sourceTimestamp: r.sourceTimestamp,
      }));
    }
    return [];
  });
  const manager = { query };
  // Overload-uyumlu jest.fn: her iki çağrı şekli de aynı manager'ı görür.
  const txMock = jest.fn(async (...args: unknown[]) => {
    const fn = (typeof args[0] === 'function' ? args[0] : args[1]) as (m: unknown) => Promise<unknown>;
    return fn(manager);
  });
  const dataSource: Partial<DataSource> = { transaction: txMock as never };

  const storage: Partial<MinioClientService> = {
    generateFilePath: (tenantId: string, entityType: string, entityId: string, filename: string) =>
      `${tenantId}/${entityType}/${entityId}/${filename}`,
    uploadFile: jest.fn(async (tenantId: string, entityType: string, entityId: string, filename: string, buffer: Buffer) => {
      uploaded.push({ tenantId, entityType, entityId, filename, buffer });
      storedBytes = buffer;
      return { path: `${tenantId}/${entityType}/${entityId}/${filename}`, etag: 'etag' } as never;
    }),
    downloadFile: jest.fn(async () => {
      if (!storedBytes) throw new Error('object not found');
      return storedBytes;
    }),
  };

  const ledger: Partial<TelemetryRetentionOrchestratorService> = {
    append: jest.fn(async (event: Record<string, unknown>) => {
      ledgerEvents.push(event);
    }),
  };

  const exporter = new TelemetryParquetExporterService(
    dataSource as DataSource,
    storage as MinioClientService,
    ledger as TelemetryRetentionOrchestratorService,
  );
  const verifier = new TelemetryParquetVerifierService(
    storage as MinioClientService,
    ledger as TelemetryRetentionOrchestratorService,
  );
  return { exporter, verifier, txMock, queries, uploaded, ledgerEvents, setObject: (b) => (storedBytes = b) };
}

describe('TelemetryParquetExporterService (Task 6)', () => {
  it('snapshots under REPEATABLE READ with CSN+LSN provenance', async () => {
    const h = makeHarness();
    await h.exporter.exportTenantDay(TENANT, DAY);

    expect(h.txMock).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    expect(h.queries.some((q) => q.sql.includes('txid_current_snapshot()'))).toBe(true);
    expect(h.queries.some((q) => q.sql.includes('pg_current_wal_lsn()'))).toBe(true);
  });

  it('streams rows in PK order and appends EXPORT_STARTED then EXPORTED with the manifest', async () => {
    const h = makeHarness();
    const manifest = await h.exporter.exportTenantDay(TENANT, DAY);

    expect(h.queries.some((q) => q.sql.includes('ORDER BY time, sensor_id, channel_id'))).toBe(
      true,
    );
    expect(manifest.sourceRowCount).toBe(2);
    expect(manifest.sourceSnapshot).toBe('100:105:100,104');
    expect(manifest.sourceWalLsn).toBe('0/1A2B3C4');
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    const states = h.ledgerEvents.map((e) => e['state']);
    expect(states).toEqual(['EXPORT_STARTED', 'EXPORTED']);
    const exported = h.ledgerEvents[1]!;
    expect(exported['parquetSha256']).toBe(manifest.sha256);
    expect(exported['tenantSchema']).toBe(SCHEMA);
    expect(h.uploaded).toHaveLength(1);
    expect(h.uploaded[0]!.entityType).toBe('telemetry-archive');
  });
});

describe('TelemetryParquetVerifierService (Task 6) — independent verify', () => {
  const operation = (h: Harness) => {
    const exported = h.ledgerEvents[1]!;
    return {
      operationId: exported['operationId'] as string,
      tenantId: TENANT,
      rangeStart: new Date(`${DAY}T00:00:00.000Z`),
      rangeEnd: new Date(`${DAY}T00:00:00.000Z`),
      objectKey: exported['objectKey'] as string,
      parquetSha256: exported['parquetSha256'] as string,
      sourceRowCount: exported['sourceRowCount'] as string,
    };
  };

  it('appends VERIFIED only on exact byte + structure equality', async () => {
    const h = makeHarness();
    await h.exporter.exportTenantDay(TENANT, DAY);
    const result = await h.verifier.verifyOperation(operation(h));

    expect(result).toBe('VERIFIED');
    expect(h.ledgerEvents.map((e) => e['state'])).toEqual([
      'EXPORT_STARTED',
      'EXPORTED',
      'VERIFIED',
    ]);
  });

  it('a corrupted object (sha mismatch) appends FAILED, never VERIFIED', async () => {
    const h = makeHarness();
    await h.exporter.exportTenantDay(TENANT, DAY);
    const op = operation(h);
    const tampered = { ...op, parquetSha256: '0'.repeat(64) };
    const result = await h.verifier.verifyOperation(tampered);

    expect(result).toBe('FAILED');
    expect(h.ledgerEvents.map((e) => e['state'])).toEqual([
      'EXPORT_STARTED',
      'EXPORTED',
      'FAILED',
    ]);
  });

  it('a manifest claiming a different row count than the artifact fails', async () => {
    const h = makeHarness();
    await h.exporter.exportTenantDay(TENANT, DAY);
    const op = operation(h);
    const lying = { ...op, sourceRowCount: '999' };
    const result = await h.verifier.verifyOperation(lying);

    expect(result).toBe('FAILED');
  });
});

describe('archive codec determinism', () => {
  it('the same rows always serialize to the same bytes (sha stability)', () => {
    const a = [encodeHeader({ tenantId: TENANT, tenantSchema: SCHEMA, day: DAY }), '\n'];
    for (const r of [row('2026-07-01T00:00:00.000Z'), row('2026-07-01T00:01:00.000Z')]) {
      a.push(encodeRow(r), '\n');
    }
    a.push(encodeTrailer(2), '\n');
    const bytes = Buffer.from(a.join(''), 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');

    const b = [encodeHeader({ tenantId: TENANT, tenantSchema: SCHEMA, day: DAY }), '\n'];
    for (const r of [row('2026-07-01T00:00:00.000Z'), row('2026-07-01T00:01:00.000Z')]) {
      b.push(encodeRow(r), '\n');
    }
    b.push(encodeTrailer(2), '\n');
    expect(createHash('sha256').update(Buffer.from(b.join(''), 'utf8')).digest('hex')).toBe(sha);
  });
});
