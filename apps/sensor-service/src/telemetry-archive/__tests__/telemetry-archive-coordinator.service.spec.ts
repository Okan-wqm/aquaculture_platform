import { createHash } from 'crypto';

import {
  TelemetryArchiveCoordinatorService,
  type TelemetryArchiveDependencies,
  type TelemetryArchiveManifest,
  type TelemetryRawRow,
} from '../telemetry-archive-coordinator.service';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const RANGE_START = '2026-01-01T00:00:00.000Z';
const RANGE_END = '2026-01-02T00:00:00.000Z';
const PARQUET = Buffer.from('PAR1-raw-telemetry-PAR1');
const SHA256 = createHash('sha256').update(PARQUET).digest('hex');

const RAW_ROW: TelemetryRawRow = {
  time: '2026-01-01T00:00:01.000Z',
  sensorId: '33333333-3333-4333-8333-333333333333',
  channelId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  rawValue: 12.5,
  value: 12.4,
  qualityCode: 192,
  qualityBits: 0,
  sourceEventId: 'edge-1',
  sourceTimestamp: '2026-01-01T00:00:00.900Z',
  sourceSequence: '1',
};

function manifest(): TelemetryArchiveManifest {
  return {
    operationId: OPERATION_ID,
    tenantId: TENANT_ID,
    bucket: 'aqua-telemetry-22222222222242228222222222222222',
    objectKey: `${OPERATION_ID}.parquet`,
    objectVersionId: 'version-1',
    format: 'PARQUET',
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    rowCount: 1,
    minTime: RAW_ROW.time,
    maxTime: RAW_ROW.time,
    schemaVersion: 1,
    snapshotId: '00000003-0000001B-1',
    walLsn: '0/16B6C50',
    sha256: SHA256,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
}

function dependencies(calls: string[]): TelemetryArchiveDependencies {
  return {
    lifecycle: {
      append: jest.fn(async (event) => {
        calls.push(`ledger:${event.state}`);
        return '55555555-5555-4555-8555-555555555555';
      }),
      getManifest: jest.fn(async (_operationId, state) => {
        calls.push(`ledger:get:${state}`);
        return manifest();
      }),
    },
    erasure: {
      eraseTenantLinks: jest.fn(async () => {
        calls.push('ledger:erase-links');
        return { deletedEventCount: 4, evidenceSha256: SHA256 };
      }),
    },
    source: {
      capture: jest.fn(async (_request, consume) => {
        calls.push('source:capture');
        return consume(
          {
            snapshotId: '00000003-0000001B-1',
            walLsn: '0/16B6C50',
          },
          (async function* rows(): AsyncGenerator<TelemetryRawRow> {
            yield RAW_ROW;
          })(),
        );
      }),
    },
    parquet: {
      encode: jest.fn(async (rows) => {
        calls.push('parquet:encode');
        const encodedRows: TelemetryRawRow[] = [];
        for await (const row of rows) encodedRows.push(row);
        return {
          path: '/tmp/test-telemetry.parquet',
          byteLength: PARQUET.length,
          sha256: SHA256,
          cleanup: jest.fn(async () => {
            calls.push('parquet:cleanup');
          }),
          rowCount: encodedRows.length,
          minTime: encodedRows[0]?.time ?? null,
          maxTime: encodedRows.at(-1)?.time ?? null,
        };
      }),
      inspect: jest.fn(async () => ({
        rowCount: 1,
        minTime: RAW_ROW.time,
        maxTime: RAW_ROW.time,
        sha256: SHA256,
        format: 'raw-v1' as const,
        schemaVersion: 1,
      })),
      decode: jest.fn(async function* (): AsyncGenerator<TelemetryRawRow> {
        yield RAW_ROW;
      }),
    },
    exporterStore: {
      identity: 'telemetry-archive-exporter',
      put: jest.fn(async (request) => {
        calls.push(`exporter:put:${request.bucket}`);
        return { versionId: 'version-1' };
      }),
      get: jest.fn(async () => {
        throw new Error('exporter identity may not read archive objects');
      }),
      deleteObjectVersion: jest.fn(async () => {
        throw new Error('exporter identity may not delete archive objects');
      }),
      deleteTenantBucket: jest.fn(async () => {
        throw new Error('exporter identity may not delete tenant buckets');
      }),
    },
    verifierStore: {
      identity: 'telemetry-archive-verifier',
      put: jest.fn(async () => {
        throw new Error('verifier identity may not write archive objects');
      }),
      get: jest.fn(async () => {
        calls.push('verifier:get');
        return {
          path: '/tmp/verifier.parquet',
          byteLength: PARQUET.length,
          sha256: SHA256,
          cleanup: jest.fn(async () => {
            calls.push('verifier:cleanup');
          }),
        };
      }),
      deleteObjectVersion: jest.fn(async () => {
        throw new Error('verifier identity may not delete archive objects');
      }),
      deleteTenantBucket: jest.fn(async () => {
        throw new Error('verifier identity may not delete tenant buckets');
      }),
    },
    restoreStore: {
      identity: 'telemetry-archive-restore',
      put: jest.fn(async () => {
        throw new Error('restore identity may not write archive objects');
      }),
      get: jest.fn(async () => {
        calls.push('restore:get');
        return {
          path: '/tmp/restore.parquet',
          byteLength: PARQUET.length,
          sha256: SHA256,
          cleanup: jest.fn(async () => {
            calls.push('restore:cleanup');
          }),
        };
      }),
      deleteObjectVersion: jest.fn(async () => {
        throw new Error('restore identity may not delete archive objects');
      }),
      deleteTenantBucket: jest.fn(async () => {
        throw new Error('restore identity may not delete tenant buckets');
      }),
    },
    erasureStore: {
      identity: 'telemetry-archive-erasure',
      put: jest.fn(async () => {
        throw new Error('erasure identity may not write archive objects');
      }),
      get: jest.fn(async () => {
        throw new Error('erasure identity may not read archive objects');
      }),
      deleteObjectVersion: jest.fn(async () => {
        calls.push('erasure:delete-object-version');
      }),
      deleteTenantBucket: jest.fn(async (_tenantId, _bucket, beforeDestructiveStep) => {
        await beforeDestructiveStep();
        await beforeDestructiveStep();
        calls.push('erasure:delete-bucket');
      }),
    },
    scratchRestore: {
      restore: jest.fn(async (_request, rows) => {
        calls.push('scratch:restore');
        let rowCount = 0;
        for await (const _row of rows) rowCount += 1;
        return {
          schemaName: 'restore_66666666666646668666666666666666',
          expiresAt: '2026-01-02T01:00:00.000Z',
          rowCount,
          sha256: SHA256,
          analyticQueriesPassed: true,
        };
      }),
    },
    legalHold: {
      assertNoHold: jest.fn(async () => {
        calls.push('legal-hold:checked');
      }),
    },
    presigns: {
      revokeTenant: jest.fn(async () => {
        calls.push('presigns:revoke');
      }),
    },
    pendingExports: {
      assertTenantActive: jest.fn(async () => {
        calls.push('exports:active');
      }),
      cancelTenant: jest.fn(async () => {
        calls.push('exports:cancel');
      }),
    },
    clock: {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    },
  };
}

describe('TelemetryArchiveCoordinatorService', () => {
  it('exports raw rows only after ledger start, in a tenant-specific bucket', async () => {
    const calls: string[] = [];
    const service = new TelemetryArchiveCoordinatorService(dependencies(calls));

    const exported = await service.exportRange({
      operationId: OPERATION_ID,
      tenantId: TENANT_ID,
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
      schemaVersion: 1,
    });

    expect(exported).toEqual(manifest());
    expect(calls).toEqual([
      'exports:active',
      'ledger:EXPORT_STARTED',
      'source:capture',
      'parquet:encode',
      'exports:active',
      'exporter:put:aqua-telemetry-22222222222242228222222222222222',
      'ledger:EXPORTED',
      'parquet:cleanup',
    ]);
  });

  it('removes the exact uploaded version when the EXPORTED ledger transition fails', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.lifecycle.append = jest.fn(async (event) => {
      calls.push(`ledger:${event.state}`);
      if (event.state === 'EXPORTED') throw new Error('ledger unavailable');
      return '55555555-5555-4555-8555-555555555555';
    });
    const service = new TelemetryArchiveCoordinatorService(deps);

    await expect(
      service.exportRange({
        operationId: OPERATION_ID,
        tenantId: TENANT_ID,
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        schemaVersion: 1,
      }),
    ).rejects.toThrow('ledger unavailable');

    expect(deps.erasureStore.deleteObjectVersion).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      bucket: manifest().bucket,
      objectKey: manifest().objectKey,
      versionId: manifest().objectVersionId,
    });
    expect(calls).toContain('erasure:delete-object-version');
  });

  it('uses the independent verifier identity and refuses any manifest mismatch', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    const service = new TelemetryArchiveCoordinatorService(deps);

    await service.verify(OPERATION_ID);
    expect(calls).toEqual([
      'ledger:get:EXPORTED',
      'verifier:get',
      'ledger:VERIFIED',
      'verifier:cleanup',
    ]);

    calls.length = 0;
    deps.parquet.inspect = jest.fn(async () => ({
      rowCount: 2,
      minTime: RAW_ROW.time,
      maxTime: RAW_ROW.time,
      sha256: SHA256,
      format: 'raw-v1' as const,
      schemaVersion: 1,
    }));
    await expect(service.verify(OPERATION_ID)).rejects.toThrow(/manifest mismatch/i);
    expect(calls).toEqual([
      'ledger:get:EXPORTED',
      'verifier:get',
      'ledger:FAILED',
      'verifier:cleanup',
    ]);

    calls.length = 0;
    deps.parquet.inspect = jest.fn(async () => ({
      rowCount: 1,
      minTime: RAW_ROW.time,
      maxTime: RAW_ROW.time,
      sha256: SHA256,
      format: 'raw-v1' as const,
      schemaVersion: 2,
    }));
    await expect(service.verify(OPERATION_ID)).rejects.toThrow(/manifest mismatch/i);
  });

  it('restores through the read-only restore identity into an expiring scratch schema', async () => {
    const calls: string[] = [];
    const service = new TelemetryArchiveCoordinatorService(dependencies(calls));

    const restored = await service.restore({ operationId: OPERATION_ID, ttlSeconds: 3600 });

    expect(restored.analyticQueriesPassed).toBe(true);
    expect(restored.rowCount).toBe(1);
    expect(calls).toEqual([
      'ledger:get:VERIFIED',
      'restore:get',
      'scratch:restore',
      'restore:cleanup',
    ]);
    await expect(service.restore({ operationId: OPERATION_ID, ttlSeconds: 0 })).rejects.toThrow(
      /TTL/i,
    );
  });

  it('re-checks legal hold immediately before every destructive erasure step', async () => {
    const calls: string[] = [];
    const service = new TelemetryArchiveCoordinatorService(dependencies(calls));

    const evidence = await service.eraseTenantArchive({
      tenantId: TENANT_ID,
      erasureOperationId: OPERATION_ID,
    });

    expect(calls).toEqual([
      'legal-hold:checked',
      'exports:cancel',
      'legal-hold:checked',
      'presigns:revoke',
      'legal-hold:checked',
      'legal-hold:checked',
      'legal-hold:checked',
      'erasure:delete-bucket',
      'legal-hold:checked',
      'ledger:erase-links',
    ]);
    expect(evidence).toEqual({ deletedEventCount: 4, evidenceSha256: SHA256 });
  });
});
