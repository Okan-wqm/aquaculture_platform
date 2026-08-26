import type { DataSource } from 'typeorm';

import { PostgresTelemetryScratchRestoreService } from '../postgres-telemetry-scratch-restore.service';
import type { TelemetryRawRow } from '../telemetry-archive-coordinator.service';

const ROW: TelemetryRawRow = {
  time: '2026-01-01T00:00:01.000Z',
  sensorId: '33333333-3333-4333-8333-333333333333',
  channelId: '44444444-4444-4444-8444-444444444444',
  tenantId: '22222222-2222-4222-8222-222222222222',
  rawValue: 12.5,
  value: 12.4,
  qualityCode: 192,
  qualityBits: 0,
  sourceEventId: 'edge-1',
  sourceTimestamp: '2026-01-01T00:00:00.900Z',
  sourceSequence: '1',
};

async function* rows(): AsyncGenerator<TelemetryRawRow> {
  yield ROW;
}

describe('PostgresTelemetryScratchRestoreService', () => {
  it('refuses production privileges and restores only into a TTL scratch schema', async () => {
    const sql: string[] = [];
    const runner = {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      query: jest.fn(async (statement: string) => {
        sql.push(statement.replaceAll(/\s+/g, ' ').trim());
        if (statement.includes('current_user AS "roleName"')) {
          return [
            {
              roleName: 'telemetry_archive_restore',
              isRestoreRoleMember: true,
              canCreateDatabase: false,
              canWriteTenantSchema: false,
              canMutateArchiveLedger: false,
            },
          ];
        }
        if (statement.includes('create_telemetry_restore_scratch')) {
          return [{ schemaName: 'restore_11111111111141118111111111111111' }];
        }
        if (statement.includes('percentile_cont')) {
          return [{ rowCount: '1', p50: 12.4, minValue: 12.4, maxValue: 12.4 }];
        }
        return [];
      }),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    };
    const source: Partial<DataSource> = { createQueryRunner: () => runner as never };
    const service = new PostgresTelemetryScratchRestoreService(source as DataSource, {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await service.restore(
      {
        tenantId: ROW.tenantId,
        operationId: '11111111-1111-4111-8111-111111111111',
        expectedSha256: 'a'.repeat(64),
        ttlSeconds: 3600,
      },
      rows(),
    );

    expect(result).toEqual({
      schemaName: 'restore_11111111111141118111111111111111',
      expiresAt: '2026-01-02T01:00:00.000Z',
      rowCount: 1,
      sha256: 'a'.repeat(64),
      analyticQueriesPassed: true,
    });
    expect(sql.join('\n')).toContain('sensor.create_telemetry_restore_scratch');
    expect(sql.join('\n')).not.toContain('CREATE SCHEMA');
    expect(sql.join('\n')).not.toContain('INSERT INTO sensor.sensor_metrics');
    expect(sql.join('\n')).not.toContain('INSERT INTO "tenant_');
  });

  it('fails closed if the restore identity can mutate production data', async () => {
    const runner = {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      query: jest.fn(async () => [
        {
          roleName: 'sensor_service',
          isRestoreRoleMember: false,
          canCreateDatabase: true,
          canWriteTenantSchema: true,
          canMutateArchiveLedger: true,
        },
      ]),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    };
    const source: Partial<DataSource> = { createQueryRunner: () => runner as never };
    const service = new PostgresTelemetryScratchRestoreService(source as DataSource, {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(
      service.restore(
        {
          tenantId: ROW.tenantId,
          operationId: '11111111-1111-4111-8111-111111111111',
          expectedSha256: 'a'.repeat(64),
          ttlSeconds: 3600,
        },
        rows(),
      ),
    ).rejects.toThrow(/restore identity/i);
    expect(runner.rollbackTransaction).toHaveBeenCalled();
  });

  it('drops expired scratch schemas through the allowlisted privileged function', async () => {
    const query = jest.fn(async (statement: string) =>
      statement.includes('drop_expired_telemetry_restore_scratch') ? [{ droppedCount: '2' }] : [],
    );
    const runner = {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      query,
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    };
    const source: Partial<DataSource> = { createQueryRunner: () => runner as never };
    const service = new PostgresTelemetryScratchRestoreService(source as DataSource, {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(service.cleanupExpired()).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith('SET LOCAL ROLE telemetry_archive_restore');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('sensor.drop_expired_telemetry_restore_scratch'),
    );
    expect(runner.commitTransaction).toHaveBeenCalled();
  });
});
