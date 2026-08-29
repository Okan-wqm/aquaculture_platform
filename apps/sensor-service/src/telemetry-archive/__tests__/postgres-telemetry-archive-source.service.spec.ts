import { Readable } from 'stream';
import type { DataSource } from 'typeorm';

import { PostgresTelemetryArchiveSourceService } from '../postgres-telemetry-archive-source.service';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('PostgresTelemetryArchiveSourceService', () => {
  it('holds a repeatable-read, read-only snapshot while streaming rows in PK order', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql.replaceAll(/\s+/g, ' ').trim());
      if (sql.includes('pg_export_snapshot')) {
        return [{ snapshotId: '00000003-0000001B-1', walLsn: '0/16B6C50' }];
      }
      return [];
    });
    const runner = {
      connect: jest.fn(async () => {
        calls.push('connect');
      }),
      startTransaction: jest.fn(async (level) => {
        calls.push(`begin:${level}`);
      }),
      query,
      stream: jest.fn(async (sql: string) => {
        calls.push(sql.replaceAll(/\s+/g, ' ').trim());
        return Readable.from([
          {
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
          },
        ]);
      }),
      commitTransaction: jest.fn(async () => {
        calls.push('commit');
      }),
      rollbackTransaction: jest.fn(async () => {
        calls.push('rollback');
      }),
      release: jest.fn(async () => {
        calls.push('release');
      }),
    };
    const dataSource: Partial<DataSource> = {
      createQueryRunner: () => runner as never,
    };
    const service = new PostgresTelemetryArchiveSourceService(dataSource as DataSource);

    const result = await service.capture(
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        tenantId: TENANT_ID,
        rangeStart: '2026-01-01T00:00:00.000Z',
        rangeEnd: '2026-01-02T00:00:00.000Z',
        schemaVersion: 1,
      },
      async (snapshot, rows) => {
        const captured = [];
        for await (const row of rows) captured.push(row);
        return { snapshot, captured };
      },
    );

    expect(result.snapshot).toEqual({
      snapshotId: '00000003-0000001B-1',
      walLsn: '0/16B6C50',
    });
    expect(result.captured).toHaveLength(1);
    expect(calls[0]).toBe('connect');
    expect(calls[1]).toBe('begin:REPEATABLE READ');
    expect(calls[2]).toBe('SET TRANSACTION READ ONLY');
    expect(calls.join('\n')).toContain('FROM "tenant_2222222222224222".sensor_metrics');
    expect(calls.join('\n')).toContain('ORDER BY time, sensor_id, channel_id');
    expect(calls.at(-2)).toBe('commit');
    expect(calls.at(-1)).toBe('release');
  });
});
