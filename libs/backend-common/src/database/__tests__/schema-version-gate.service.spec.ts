import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { createSchemaVersionGate } from '../schema-version-gate.service';

function mockConfig(): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        DB_MIGRATE_AUTHORITATIVE: 'true',
        DATABASE_MIGRATIONS_RUN: 'false',
        NODE_ENV: 'production',
      };
      return values[key] ?? fallback;
    }),
  } as unknown as ConfigService;
}

function bootstrapRow(): Array<{
  last_run_at: Date;
  schema_count: number;
  function_count: number;
  shared_table_count: number;
  bootstrap_version: string;
}> {
  return [
    {
      last_run_at: new Date('2026-05-20T00:00:00Z'),
      schema_count: 16,
      function_count: 4,
      shared_table_count: 5,
      bootstrap_version: 'test',
    },
  ];
}

describe('SchemaVersionGate release-ledger lifecycle', () => {
  it('accepts rollback_failed rows that already recorded expected migration heads', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce(bootstrapRow())
        .mockResolvedValueOnce([
          {
            last_ts: '1800300000000',
            last_name: 'AlignEquipmentTypesRuntimeContract1800300000000',
            row_count: '4',
          },
        ])
        .mockResolvedValueOnce([
          {
            release_id: 'release-1',
            expected_ts: '1800300000000',
            expected_name: 'AlignEquipmentTypesRuntimeContract1800300000000',
          },
        ]),
    } as unknown as jest.Mocked<DataSource>;

    const Gate = createSchemaVersionGate('farm', {
      mode: 'gate',
      tenantAware: false,
    });
    await new Gate(dataSource, mockConfig()).onApplicationBootstrap();

    expect(dataSource.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('status = ANY($2::text[])'),
      [
        'farm',
        expect.arrayContaining([
          'db_complete',
          'apps_restarting',
          'promoted',
          'failed',
          'rollback_attempted',
          'rollback_verified',
          'rollback_failed',
          'rolled_back',
        ]),
      ],
    );
  });

  it('still rejects when the release ledger does not declare the expected head', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce(bootstrapRow())
        .mockResolvedValueOnce([
          {
            last_ts: '1800300000000',
            last_name: 'AlignEquipmentTypesRuntimeContract1800300000000',
            row_count: '4',
          },
        ])
        .mockResolvedValueOnce([]),
    } as unknown as jest.Mocked<DataSource>;

    const Gate = createSchemaVersionGate('farm', {
      mode: 'gate',
      tenantAware: false,
    });

    await expect(
      new Gate(dataSource, mockConfig()).onApplicationBootstrap(),
    ).rejects.toThrow(/No release ledger row with migration heads exists/);
  });
});
