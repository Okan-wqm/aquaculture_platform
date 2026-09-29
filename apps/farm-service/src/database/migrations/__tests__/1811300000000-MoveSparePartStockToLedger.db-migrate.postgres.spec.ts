/**
 * The B1a-1 farm migrations under the conditions db-migrate runs them in —
 * REAL PostgreSQL (UNVERIFIED items of the B1a-1 verifier round).
 *
 * ## What the other suites do not prove
 *
 * `1811300000000-MoveSparePartStockToLedger.postgres.spec.ts` and the ledger
 * suites run the migrations on synchronize-built tables with no row-level
 * security and no source-schema write guard. Production differs in three ways
 * this suite reproduces:
 *
 *   1. Tables a previous release created already carry ENABLE + FORCE row
 *      level security and `tenant_isolation_policy` (db-migrate's
 *      post-migration hardening, `applyTenantRlsToSchema`), in the `farm`
 *      source schema and in every `tenant_<uuid>` clone.
 *   2. The `farm` source schema's per-tenant tables carry `guard_source_write`
 *      (`assertSourceSchemaWriteGuards`), which refuses every row write, for a
 *      superuser too.
 *   3. db-migrate connects as the cluster superuser, pins
 *      `search_path = "<schema>", public`, runs each migration in its own
 *      transaction and sets no tenant GUC.
 *
 * WHAT it proves: the data migration's INSERTs land in a tenant schema whose
 * tables FORCE row level security (the policy is live — a non-superuser sees
 * nothing without the tenant GUC), the source-schema pass succeeds under the
 * write guard (the source template holds no parts), and after the hardening
 * the new `storage_item_site_policies` table carries ENABLE + FORCE RLS and the
 * tenant policy in the `farm` source schema AND in the tenant clone.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  applyTenantRlsToSchema,
  assertSourceSchemaWriteGuards,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';

import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { SparePart } from '../../../maintenance/entities/spare-part.entity';
import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { StorageInventory } from '../../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../../storage/entities/storage-location.entity';
import { Supplier } from '../../../supplier/entities/supplier.entity';
import { CreateStorageItemSitePolicies1811100000000 } from '../1811100000000-CreateStorageItemSitePolicies';
import { MoveSparePartStockToLedger1811300000000 } from '../1811300000000-MoveSparePartStockToLedger';
import { RestoreStorageInventoryCanonicalKey1809700000000 } from '../1809700000000-RestoreStorageInventoryCanonicalKey';

const TENANT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const TENANT_SCHEMA = getTenantSchemaName(TENANT);
/** The ledger tables a previous release created (hardened before this release). */
const EXISTING_TABLES = [
  'spare_parts',
  'storage_locations',
  'storage_inventory',
  'stock_movements',
];
const PROBE_ROLE = `rls_probe_${randomBytes(3).toString('hex')}`;

/** A migration with the optional post-condition probe db-migrate evaluates. */
interface MigrationWithProbe extends MigrationInterface {
  postCondition?(queryRunner: QueryRunner): Promise<boolean>;
}

describe('B1a-1 farm migrations as db-migrate runs them — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    // uuid_generate_v4() (1811100000000's id default) comes from uuid-ossp, which
    // db-migrate's platform bootstrap installs first
    // (apps/db-migrate/src/sql/platform-bootstrap/001-extensions.sql).
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-b1a1-db-migrate-${randomBytes(4).toString('hex')}`,
      entities: [
        SparePart,
        Supplier,
        EquipmentType,
        StorageLocation,
        StorageInventory,
        StockMovement,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    // The production spellings of the two arbiters the data migration relies on.
    await dataSource.query(`
      DROP INDEX IF EXISTS "idx_stock_movements_tenant_idempotency";
      DROP INDEX IF EXISTS "IDX_93018beb62439a265dcb715936";
      DROP INDEX IF EXISTS "IDX_stock_movements_idempotency_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_stock_movements_tenant_idempotency"
        ON stock_movements ("tenant_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
    await runMigration('farm', new RestoreStorageInventoryCanonicalKey1809700000000());
    // Pre-migration shape: the column 1811300000000 adds does not exist yet.
    await dataSource.query('ALTER TABLE "farm"."spare_parts" DROP COLUMN "storageLocationId"');

    // A tenant clone of the source, as tenant provisioning builds it.
    await dataSource.query(`CREATE SCHEMA "${TENANT_SCHEMA}"`);
    for (const table of EXISTING_TABLES) {
      await dataSource.query(
        `CREATE TABLE "${TENANT_SCHEMA}"."${table}" (LIKE "farm"."${table}" INCLUDING ALL)`,
      );
    }

    // What a previous release left behind: FORCE RLS + tenant policy in both
    // schemas, and the source write guard in `farm`.
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    await harden('farm');
    await harden(TENANT_SCHEMA);
    await assertSourceSchemaWriteGuards(dataSource, 'farm');

    // The probe role: an ordinary, non-superuser reader (FORCE RLS applies to it).
    await dataSource.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
    await dataSource.query(`GRANT USAGE ON SCHEMA "${TENANT_SCHEMA}" TO ${PROBE_ROLE}`);
  });

  afterAll(async () => {
    if (previousDdlAuthority === undefined) {
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
    } else {
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  /** db-migrate's post-migration hardening of one schema. */
  async function harden(schema: string): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      await applyTenantRlsToSchema(queryRunner, { schemaOverride: schema });
    } finally {
      await queryRunner.query('RESET search_path');
      await queryRunner.release();
    }
  }

  /**
   * One migration the way db-migrate's orchestrator applies it: pinned
   * search_path, its own transaction, the post-condition inside it.
   */
  async function runMigration(schema: string, migration: MigrationWithProbe): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      await queryRunner.startTransaction();
      await migration.up(queryRunner);
      if (migration.postCondition && !(await migration.postCondition(queryRunner))) {
        throw new Error(`${migration.constructor.name} post-condition failed in ${schema}`);
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.query('RESET search_path');
      await queryRunner.release();
    }
  }

  async function security(
    schema: string,
    table: string,
  ): Promise<{ enabled: boolean; forced: boolean; policies: number }> {
    const rows: Array<{ enabled: boolean; forced: boolean; policies: string }> =
      await dataSource.query(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT COUNT(*)::text FROM pg_policy p
                  WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation_policy') AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
    const [row] = rows;
    if (!row) throw new Error(`${schema}.${table} does not exist`);
    return { enabled: row.enabled, forced: row.forced, policies: Number(row.policies) };
  }

  /** Rows of a tenant table as the non-superuser probe sees them. */
  async function probeCount(table: string, tenantGuc: string | null): Promise<number> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.startTransaction();
      await queryRunner.query(`GRANT SELECT ON "${TENANT_SCHEMA}"."${table}" TO ${PROBE_ROLE}`);
      await queryRunner.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
      if (tenantGuc !== null) {
        await queryRunner.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantGuc]);
      }
      const rows: Array<{ total: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS total FROM "${TENANT_SCHEMA}"."${table}"`,
      );
      await queryRunner.rollbackTransaction();
      return Number(rows[0]?.total ?? '0');
    } finally {
      await queryRunner.release();
    }
  }

  it('runs as a superuser, like db-migrate (the premise every case below rests on)', async () => {
    // SCENARIO: the connection db-migrate would hold. EXPECTS: a superuser role —
    // production's migrate role is the cluster superuser, which FORCE RLS does not bind.
    const rows: Array<{ superuser: boolean }> = await dataSource.query(
      'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ superuser: true }]);
  });

  it('imports spare-part stock into a tenant schema whose tables FORCE row level security', async () => {
    // SCENARIO: the tenant clone holds two stocked parts at a mapped location; the
    // four ledger tables FORCE RLS (a previous release). 1811100000000 then
    // 1811300000000 run like db-migrate. EXPECTS: both migrations commit, both
    // opening movements and inventory rows exist, and the policy is live: the
    // non-superuser probe sees no movement without the tenant GUC and both with it.
    for (const table of EXISTING_TABLES) {
      expect(await security(TENANT_SCHEMA, table)).toEqual({
        enabled: true,
        forced: true,
        policies: 1,
      });
    }
    const location = randomUUID();
    await dataSource.query(
      `INSERT INTO "${TENANT_SCHEMA}"."storage_locations"
         ("id", "tenant_id", "site_id", "code", "name", "used_capacity", "version")
       VALUES ($1, $2, $3, 'STORE-1', 'Main store', 0, 1)`,
      [location, TENANT, randomUUID()],
    );
    for (const [code, quantity] of [
      ['SP-1', 4],
      ['SP-2', 9],
    ] as const) {
      await dataSource.query(
        `INSERT INTO "${TENANT_SCHEMA}"."spare_parts"
           ("id", "tenantId", "name", "code", "partNumber", "quantity", "unit", "location", "version")
         VALUES ($1, $2, $3, $3, $3, $4, 'piece', '{"warehouse":"store-1"}'::jsonb, 1)`,
        [randomUUID(), TENANT, code, quantity],
      );
    }

    await runMigration(TENANT_SCHEMA, new CreateStorageItemSitePolicies1811100000000());
    await runMigration(TENANT_SCHEMA, new MoveSparePartStockToLedger1811300000000());

    const imported: Array<{ quantity: string }> = await dataSource.query(
      `SELECT "quantity"::text AS quantity FROM "${TENANT_SCHEMA}"."storage_inventory"
        WHERE "item_type" = 'spare_part' ORDER BY "quantity"`,
    );
    expect(imported.map((row) => Number(row.quantity))).toEqual([4, 9]);
    expect(await probeCount('stock_movements', null)).toBe(0);
    expect(await probeCount('stock_movements', TENANT)).toBe(2);
  });

  it('passes the source schema under the write guard, then hardens the new table in both schemas', async () => {
    // SCENARIO: the `farm` source template (no parts) carries guard_source_write
    // and FORCE RLS; both migrations run there like db-migrate, then the
    // post-migration hardening runs on `farm` and on the tenant clone.
    // EXPECTS: the source pass commits (no row reaches the guard) and leaves the
    // template empty; storage_item_site_policies ends ENABLE + FORCE RLS with the
    // tenant policy in `farm` and in the tenant schema.
    const guarded: Array<{ tablename: string }> = await dataSource.query(
      `SELECT c.relname AS tablename FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'farm' AND t.tgname = 'guard_source_write' ORDER BY 1`,
    );
    expect(guarded.map((row) => row.tablename)).toEqual(expect.arrayContaining(EXISTING_TABLES));

    await runMigration('farm', new CreateStorageItemSitePolicies1811100000000());
    await runMigration('farm', new MoveSparePartStockToLedger1811300000000());
    const sourceRows: Array<{ total: string }> = await dataSource.query(
      'SELECT COUNT(*)::text AS total FROM "farm"."stock_movements"',
    );
    expect(sourceRows).toEqual([{ total: '0' }]);

    await harden('farm');
    await harden(TENANT_SCHEMA);

    expect(await security('farm', 'storage_item_site_policies')).toEqual({
      enabled: true,
      forced: true,
      policies: 1,
    });
    expect(await security(TENANT_SCHEMA, 'storage_item_site_policies')).toEqual({
      enabled: true,
      forced: true,
      policies: 1,
    });
  });
});
