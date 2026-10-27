import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AlignAlertIncidentRuleIdWithEntity1824200000000 } from '../1824200000000-AlignAlertIncidentRuleIdWithEntity';

/**
 * `alert_incidents.rule_id` on real Postgres: the uuid column that made every
 * farm-signal incident fail, aligned with what the entity declares (text).
 *
 * Run the way the runners run it: once per schema (the source `alert` schema,
 * which carries the foreign key to `alert_rules`, and a tenant schema, cloned
 * without one), search_path pinned, inside the per-migration transaction, as a
 * role that owns the tables but is not a superuser.
 */

const TENANT = '5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f';
const RULE_UUID = '3f2f6c3e-7a33-4e4e-9a52-0e3a1d5f6a71';
const SYNTHETIC_KEY = 'system:meal-underfed:eedddfae-339e-4289-8039-4ba78bd3cb43';
const MIGRATOR = 'alert_incident_migrator';

jest.setTimeout(180_000);

describe('AlignAlertIncidentRuleIdWithEntity1824200000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const tenantSchema = getTenantSchemaName(TENANT);
  const schemas = ['alert', tenantSchema];

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const target of schemas) {
      await admin.query(`CREATE SCHEMA "${target}"`);
      await admin.query(`GRANT ALL ON SCHEMA "${target}" TO ${MIGRATOR}`);
    }
    // The source schema: the baseline shape, foreign key included.
    await admin.query(
      `CREATE TABLE "alert".alert_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
    );
    await admin.query(`
      CREATE TABLE "alert".alert_incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        rule_id uuid NOT NULL,
        title varchar NOT NULL,
        CONSTRAINT "FK_08af29c9206523c12da4497e8d2" FOREIGN KEY (rule_id)
          REFERENCES "alert".alert_rules(id) ON DELETE RESTRICT
      )`);
    await admin.query(
      `CREATE INDEX "IDX_08af29c9206523c12da4497e8d" ON "alert".alert_incidents (rule_id)`,
    );
    // A tenant schema: cloned from the source WITHOUT foreign keys.
    await admin.query(`
      CREATE TABLE "${tenantSchema}".alert_incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        rule_id uuid NOT NULL,
        title varchar NOT NULL
      )`);
    await admin.query(
      `CREATE INDEX "IDX_08af29c9206523c12da4497e8d" ON "${tenantSchema}".alert_incidents (rule_id)`,
    );
    for (const target of schemas) {
      await admin.query(`ALTER TABLE "${target}".alert_incidents OWNER TO ${MIGRATOR}`);
    }
    // A rule-driven incident that exists before the migration.
    await admin.query(`INSERT INTO "alert".alert_rules (id) VALUES ($1)`, [RULE_UUID]);
    await admin.query(
      `INSERT INTO "${tenantSchema}".alert_incidents (tenant_id, rule_id, title) VALUES ($1, $2, 'High temperature')`,
      [TENANT, RULE_UUID],
    );
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  /** Runs `run` as the runners do: pinned search_path, migrator role, one transaction. */
  async function asMigrator<T>(target: string, run: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = admin!.createQueryRunner();
    await qr.query(`SET search_path TO "${target}", public`);
    await qr.query(`SET ROLE ${MIGRATOR}`);
    try {
      await qr.startTransaction();
      const result = await run(qr);
      await qr.commitTransaction();
      return result;
    } catch (error) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.query('RESET ROLE');
      await qr.release();
    }
  }

  const ruleIdType = async (target: string): Promise<string> =>
    (
      (await admin!.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'alert_incidents' AND column_name = 'rule_id'`,
        [target],
      )) as Array<{ data_type: string }>
    )[0]!.data_type;

  const foreignKeys = async (target: string): Promise<number> =>
    Number(
      (
        (await admin!.query(
          `SELECT count(*)::int AS n FROM pg_constraint
            WHERE conrelid = to_regclass($1) AND contype = 'f'`,
          [`"${target}".alert_incidents`],
        )) as Array<{ n: number }>
      )[0]!.n,
    );

  const indexOnRuleId = async (target: string): Promise<number> =>
    Number(
      (
        (await admin!.query(
          `SELECT count(*)::int AS n FROM pg_indexes
            WHERE schemaname = $1 AND tablename = 'alert_incidents'
              AND indexname = 'IDX_08af29c9206523c12da4497e8d'`,
          [target],
        )) as Array<{ n: number }>
      )[0]!.n,
    );

  const raise = (target: string): Promise<unknown> =>
    admin!.query(
      `INSERT INTO "${target}".alert_incidents (tenant_id, rule_id, title)
       VALUES ($1, $2, 'Meal Underfed')`,
      [TENANT, SYNTHETIC_KEY],
    );

  it('BEFORE: a farm-signal key cannot be written — the failure the production tenant lived', async () => {
    for (const target of schemas) {
      expect(await ruleIdType(target)).toBe('uuid');
      await expect(raise(target)).rejects.toThrow(/invalid input syntax for type uuid/);
    }
  });

  it('turns rule_id into text in the source schema (dropping its foreign key) and in a tenant schema', async () => {
    const migration = new AlignAlertIncidentRuleIdWithEntity1824200000000();

    expect(await foreignKeys('alert')).toBe(1);
    for (const target of schemas) await asMigrator(target, (qr) => migration.up(qr));

    for (const target of schemas) {
      expect(await ruleIdType(target)).toBe('character varying');
      expect(await foreignKeys(target)).toBe(0);
      // The index survives the rewrite: lookups by rule key stay indexed.
      expect(await indexOnRuleId(target)).toBe(1);
    }
  });

  it('keeps every existing rule-driven incident, its rule id now text', async () => {
    const rows = await admin!.query(
      `SELECT rule_id, title FROM "${tenantSchema}".alert_incidents WHERE title = 'High temperature'`,
    );

    expect(rows).toEqual([{ rule_id: RULE_UUID, title: 'High temperature' }]);
  });

  it('AFTER: a farm-signal key is stored, in both schemas', async () => {
    for (const target of schemas) {
      await expect(raise(target)).resolves.toBeDefined();
      const rows = await admin!.query(
        `SELECT rule_id FROM "${target}".alert_incidents WHERE rule_id = $1`,
        [SYNTHETIC_KEY],
      );
      expect(rows).toEqual([{ rule_id: SYNTHETIC_KEY }]);
    }
  });

  it('is idempotent: replaying it changes nothing and does not fail', async () => {
    const migration = new AlignAlertIncidentRuleIdWithEntity1824200000000();

    for (const target of schemas) await asMigrator(target, (qr) => migration.up(qr));

    for (const target of schemas) expect(await ruleIdType(target)).toBe('character varying');
  });

  it('down refuses to narrow while a farm-signal key exists, and narrows once only uuids are left', async () => {
    const migration = new AlignAlertIncidentRuleIdWithEntity1824200000000();

    await expect(asMigrator(tenantSchema, (qr) => migration.down(qr))).rejects.toThrow(
      /refusing to narrow rule_id/,
    );
    expect(await ruleIdType(tenantSchema)).toBe('character varying');

    await admin!.query(`DELETE FROM "${tenantSchema}".alert_incidents WHERE rule_id = $1`, [
      SYNTHETIC_KEY,
    ]);
    await asMigrator(tenantSchema, (qr) => migration.down(qr));

    expect(await ruleIdType(tenantSchema)).toBe('uuid');
  });
});
