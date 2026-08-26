import { DataSource } from 'typeorm';

import { TelemetryArchiveLifecycleService } from '../telemetry-archive-lifecycle.service';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('TelemetryArchiveLifecycleService', () => {
  const query = jest.fn();
  const dataSource: Partial<DataSource> = {
    query: query as DataSource['query'],
  };
  const service = new TelemetryArchiveLifecycleService(dataSource as DataSource);

  beforeEach(() => query.mockReset());

  it('does not expose tenant erasure through the primary runtime database identity', () => {
    expect('eraseTenantLinks' in service).toBe(false);
  });

  it('delegates append-only state validation to the database function', async () => {
    query.mockResolvedValue([{ event_id: '33333333-3333-4333-8333-333333333333' }]);

    await service.append({
      operationId: OPERATION_ID,
      tenantId: TENANT_ID,
      state: 'EXPORT_STARTED',
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-02-01T00:00:00.000Z',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('sensor.append_telemetry_archive_event'),
      expect.arrayContaining([OPERATION_ID, TENANT_ID, 'EXPORT_STARTED']),
    );
  });

  it('keeps raw DROPPED transitions disabled pending LEGAL-001', async () => {
    await expect(
      service.append({
        operationId: OPERATION_ID,
        tenantId: TENANT_ID,
        state: 'DROPPED',
        rangeStart: '2026-01-01T00:00:00.000Z',
        rangeEnd: '2026-02-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/LEGAL-001/);
    expect(query).not.toHaveBeenCalled();
  });

  it('loads the authoritative version-bound manifest from the lifecycle ledger', async () => {
    query.mockResolvedValue([
      {
        operationId: OPERATION_ID,
        tenantId: TENANT_ID,
        bucket: 'aqua-telemetry-22222222222242228222222222222222',
        objectKey: `${OPERATION_ID}.parquet`,
        objectVersionId: 'version-1',
        rangeStart: new Date('2026-01-01T00:00:00.000Z'),
        rangeEnd: new Date('2026-02-01T00:00:00.000Z'),
        rowCount: '1',
        minTime: new Date('2026-01-01T00:00:01.000Z'),
        maxTime: new Date('2026-01-01T00:00:01.000Z'),
        schemaVersion: 1,
        snapshotId: 'snapshot-1',
        walLsn: '0/16B6C50',
        sha256: 'a'.repeat(64),
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    ]);

    await expect(service.getManifest(OPERATION_ID, 'VERIFIED')).resolves.toMatchObject({
      operationId: OPERATION_ID,
      objectVersionId: 'version-1',
      format: 'PARQUET',
      rowCount: 1,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('object_version_id'), [
      OPERATION_ID,
      'VERIFIED',
    ]);
  });

  it('rejects empty and reversed archive ranges before acquiring a database lock', async () => {
    await expect(
      service.append({
        operationId: OPERATION_ID,
        tenantId: TENANT_ID,
        state: 'EXPORT_STARTED',
        rangeStart: '2026-02-01T00:00:00.000Z',
        rangeEnd: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/range/i);
    expect(query).not.toHaveBeenCalled();
  });
});
