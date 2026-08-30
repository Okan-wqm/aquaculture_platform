import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { hasDbMigrateDdlAuthority } from '../db-migrate-authority.util';
import { queryRowsNormalized } from '../query-result-normalizer';
import { ProvisioningStatus, SchemaManagerService } from '../schema-manager.service';
import { getTenantSchemaName, listTenantSchemas } from '../tenant-schema.utils';

interface ExistsRow {
  exists: boolean;
}

interface TableNameRow {
  table_name: string;
}

interface ColumnDefinitionRow {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

interface PrivilegeRow {
  has_usage: boolean;
}

const FIRST_TENANT_ID = randomUUID();
const SECOND_TENANT_ID = randomUUID();
const TENANT_IDS = [FIRST_TENANT_ID, SECOND_TENANT_ID] as const;
const TENANT_SCHEMAS = [
  getTenantSchemaName(FIRST_TENANT_ID),
  getTenantSchemaName(SECOND_TENANT_ID),
] as const;
const UNPROVISIONED_TENANT_ID = randomUUID();
const UNPROVISIONED_SCHEMA = getTenantSchemaName(UNPROVISIONED_TENANT_ID);
const PROBE_TABLE = `schema_integrity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const DB_MIGRATE_FIXTURE_AUTHORITY = {
  DB_MIGRATE_DDL_AUTHORITY: '1',
} as const;

/**
 * Schema integrity integration tests for the post-DDL-authority architecture.
 *
 * Runtime services may inspect a tenant schema, but aqua-db-migrate is the only
 * process allowed to create or mutate one. The fixture helper below models that
 * authority boundary explicitly and uses unique tenant schemas so concurrent
 * integration workers cannot share state.
 *
 * Run with:
 * DATABASE_HOST=127.0.0.1 DATABASE_PORT=32768 \
 * DATABASE_USER=aquaculture DATABASE_PASSWORD=aquaculture \
 * DATABASE_NAME=aquaculture \
 * npx jest --config libs/backend-common/jest.config.ts \
 *   --runInBand schema-integrity.integration.spec.ts
 */
describe('Schema Integrity (Integration)', () => {
  let dataSource: DataSource;
  let schemaManager: SchemaManagerService;

  async function queryRows<T extends object>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    const result: unknown = await dataSource.query(sql, parameters);
    return queryRowsNormalized<T>(result);
  }

  async function executeDbMigrateFixtureDdl(sql: string): Promise<void> {
    if (!hasDbMigrateDdlAuthority(DB_MIGRATE_FIXTURE_AUTHORITY)) {
      throw new Error('Schema integration fixture requires aqua-db-migrate DDL authority');
    }
    await dataSource.query(sql);
  }

  async function schemaExists(schemaName: string): Promise<boolean> {
    const rows = await queryRows<ExistsRow>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.schemata
          WHERE schema_name = $1
       ) AS exists`,
      [schemaName],
    );
    return rows[0]?.exists === true;
  }

  async function tableNames(schemaName: string): Promise<string[]> {
    const rows = await queryRows<TableNameRow>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [schemaName],
    );
    return rows.map((row) => row.table_name);
  }

  async function columnDefinitions(schemaName: string): Promise<ColumnDefinitionRow[]> {
    return queryRows<ColumnDefinitionRow>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
        ORDER BY ordinal_position`,
      [schemaName, PROBE_TABLE],
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env['DATABASE_HOST'] ?? '127.0.0.1',
      port: Number.parseInt(process.env['DATABASE_PORT'] ?? '32768', 10),
      username: process.env['DATABASE_USER'] ?? 'aquaculture',
      password: process.env['DATABASE_PASSWORD'] ?? 'aquaculture',
      database: process.env['DATABASE_NAME'] ?? 'aquaculture',
    });
    await dataSource.initialize();
    schemaManager = new SchemaManagerService(dataSource);

    for (const schemaName of TENANT_SCHEMAS) {
      await executeDbMigrateFixtureDdl(`
        CREATE SCHEMA "${schemaName}";
        CREATE TABLE "${schemaName}"."${PROBE_TABLE}" (
          id uuid PRIMARY KEY,
          observed_at timestamptz NOT NULL DEFAULT NOW(),
          measurement double precision,
          quality_flag text NOT NULL
        );
      `);
    }
  }, 30_000);

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    for (const schemaName of TENANT_SCHEMAS) {
      await executeDbMigrateFixtureDdl(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    await dataSource.destroy();
  }, 15_000);

  it('rejects runtime provisioning without creating any schema or table', async () => {
    expect(await schemaExists(UNPROVISIONED_SCHEMA)).toBe(false);

    const result = await schemaManager.createTenantSchema(UNPROVISIONED_TENANT_ID, ['hydroponics']);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName: UNPROVISIONED_SCHEMA,
        tablesCreated: [],
        referenceDataCopied: [],
      }),
    );
    expect(result.errors).toEqual([expect.stringContaining('owned by aqua-db-migrate')]);
    expect(await schemaExists(UNPROVISIONED_SCHEMA)).toBe(false);
  });

  it('treats an incomplete db-migrate-owned schema as read-only partial state', async () => {
    const schemaName = TENANT_SCHEMAS[0];
    const beforeTables = await tableNames(schemaName);

    const result = await schemaManager.createTenantSchema(TENANT_IDS[0], ['hydroponics']);

    expect(result.success).toBe(false);
    expect(result.status).toBe(ProvisioningStatus.PARTIAL);
    expect(result.alreadyExists).toBe(true);
    expect(result.partialSuccess).toBe(true);
    expect(result.tablesCreated).toEqual([]);
    expect(result.referenceDataCopied).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await tableNames(schemaName)).toEqual(beforeTables);
  });

  it('discovers independently provisioned tenant schemas by canonical identity', async () => {
    const schemas = await listTenantSchemas(dataSource);

    for (const schemaName of TENANT_SCHEMAS) {
      expect(schemas).toContain(schemaName);
    }
    expect(schemas).toEqual([...schemas].sort());
  });

  it('keeps separately provisioned schemas structurally identical', async () => {
    const firstTables = await tableNames(TENANT_SCHEMAS[0]);
    const secondTables = await tableNames(TENANT_SCHEMAS[1]);
    const firstColumns = await columnDefinitions(TENANT_SCHEMAS[0]);
    const secondColumns = await columnDefinitions(TENANT_SCHEMAS[1]);

    expect(firstTables).toEqual([PROBE_TABLE]);
    expect(secondTables).toEqual(firstTables);
    expect(firstColumns).toEqual([
      {
        column_name: 'id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'observed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      },
      {
        column_name: 'measurement',
        data_type: 'double precision',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'quality_flag',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
    ]);
    expect(secondColumns).toEqual(firstColumns);
  });

  it.each(TENANT_SCHEMAS)('grants the connected role USAGE on %s', async (schemaName) => {
    const rows = await queryRows<PrivilegeRow>(
      `SELECT has_schema_privilege(current_user, $1, 'USAGE') AS has_usage`,
      [schemaName],
    );

    expect(rows).toEqual([{ has_usage: true }]);
  });
});
