import { ConfigService } from '@nestjs/config';
import { createMockDataSource } from '@platform/testing';
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

    await expect(new Gate(dataSource, mockConfig()).onApplicationBootstrap()).rejects.toThrow(
      /No release ledger row with migration heads exists/,
    );
  });

  it('requires tenant expected heads and tenant fan-out evidence for tenant-aware gates', async () => {
    const tenantSchema = 'tenant_4b529829ea7948da';
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
        ])
        .mockResolvedValueOnce([{ schema_name: tenantSchema }])
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
            fanout_evidence: { status: 'applied' },
          },
        ]),
    } as unknown as jest.Mocked<DataSource>;

    const Gate = createSchemaVersionGate('farm', {
      mode: 'gate',
      tenantAware: true,
    });
    await new Gate(dataSource, mockConfig()).onApplicationBootstrap();

    expect(dataSource.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("tenant_fanout #> ARRAY[$2, 'tenants', $1]"),
      [tenantSchema, 'farm', expect.arrayContaining(['db_complete', 'rollback_verified'])],
    );
  });

  it('ORPHAN-410 — accepts a tenant onboarded AFTER the release when its head matches the release source head', async () => {
    const tenantSchema = 'tenant_4b529829ea7948da';
    const head = '1800300000000';
    const headName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: head, expected_name: headName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      // Post-release tenant: no per-tenant head, but the release DOES carry a
      // source head the tenant's actual head matches → boot is allowed.
      .mockResolvedValueOnce([
        {
          release_id: 'release-1',
          expected_ts: null,
          expected_name: null,
          source_ts: head,
          source_name: headName,
          fanout_evidence: null,
        },
      ]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(
      new Gate(mockDataSource, mockConfig()).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('ORPHAN-410 — skips a tenant schema the newest release does not declare when its ledger table does not exist yet', async () => {
    // The runtime provisioner CREATEs (and commits) the tenant schema before it
    // replays a single migration into it, so between those two facts the schema
    // is visible to the gate with no `migrations_<source>` table at all. Under
    // the old contract that probe failure refused boot — fleet-wide, for every
    // tenant-aware service, for the whole provisioning window and forever after
    // a provisioning that failed and left its partial schema behind.
    const tenantSchema = 'tenant_4b529829ea7948da';
    const head = '1800300000000';
    const headName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: head, expected_name: headName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      // Ledger table not created yet — postgres raises, as it does mid-provisioning.
      .mockRejectedValueOnce(new Error('relation "migrations_farm" does not exist'))
      // The newest release does not declare this tenant → it was onboarded after
      // the release, so the deployment SSoT has nothing to hold it to.
      .mockResolvedValueOnce([{ declared: false }]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(
      new Gate(mockDataSource, mockConfig()).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('ORPHAN-410 — still refuses boot when a tenant the release DECLARED has no ledger table', async () => {
    const tenantSchema = 'tenant_4b529829ea7948da';
    const head = '1800300000000';
    const headName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: head, expected_name: headName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      .mockRejectedValueOnce(new Error('relation "migrations_farm" does not exist'))
      // Declared by the release: db-migrate DID fan out to this tenant, so a
      // missing ledger is genuine mid-fan-out damage and must still fail closed.
      .mockResolvedValueOnce([{ declared: true }]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(new Gate(mockDataSource, mockConfig()).onApplicationBootstrap()).rejects.toThrow(
      /Ledger probe FAILED/,
    );
  });

  it('ORPHAN-410 — skips an EMPTY ledger in an undeclared tenant schema, refuses when the release row is unreadable', async () => {
    const tenantSchema = 'tenant_4b529829ea7948da';
    const head = '1800300000000';
    const headName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: head, expected_name: headName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      // Ledger table exists but carries no row — the provisioner created it and
      // has not committed a migration into it yet.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ declared: false }]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(
      new Gate(mockDataSource, mockConfig()).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('ORPHAN-410 — refuses boot when NO release row exists to classify an unprobeable tenant schema', async () => {
    // Absence of evidence is not evidence of a post-release tenant: with no
    // release row at all the gate cannot tell a fresh database from a tenant
    // onboarded since the last deploy, so it keeps refusing.
    const tenantSchema = 'tenant_4b529829ea7948da';
    const head = '1800300000000';
    const headName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: head, last_name: headName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: head, expected_name: headName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      .mockRejectedValueOnce(new Error('relation "migrations_farm" does not exist'))
      .mockResolvedValueOnce([]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(new Gate(mockDataSource, mockConfig()).onApplicationBootstrap()).rejects.toThrow(
      /Ledger probe FAILED/,
    );
  });

  it('ORPHAN-410 — still refuses a post-release tenant whose head is BEHIND the release source head', async () => {
    const tenantSchema = 'tenant_4b529829ea7948da';
    const behindHead = '1800200000000';
    const releaseHead = '1800300000000';
    const releaseName = 'AlignEquipmentTypesRuntimeContract1800300000000';
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query
      .mockReset()
      .mockResolvedValueOnce(bootstrapRow())
      .mockResolvedValueOnce([{ last_ts: releaseHead, last_name: releaseName, row_count: '4' }])
      .mockResolvedValueOnce([
        { release_id: 'release-1', expected_ts: releaseHead, expected_name: releaseName },
      ])
      .mockResolvedValueOnce([{ schema_name: tenantSchema }])
      // Tenant is genuinely behind: its actual head predates the release head.
      .mockResolvedValueOnce([
        { last_ts: behindHead, last_name: 'OlderMigration1800200000000', row_count: '3' },
      ])
      .mockResolvedValueOnce([
        {
          release_id: 'release-1',
          expected_ts: null,
          expected_name: null,
          source_ts: releaseHead,
          source_name: releaseName,
          fanout_evidence: null,
        },
      ]);

    const Gate = createSchemaVersionGate('farm', { mode: 'gate', tenantAware: true });
    await expect(new Gate(mockDataSource, mockConfig()).onApplicationBootstrap()).rejects.toThrow(
      /behind the release source head/,
    );
  });
});
