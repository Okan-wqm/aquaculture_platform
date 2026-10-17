import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddAlertHistorySiteAndModule1801200000000 } from '../1801200000000-AddAlertHistorySiteAndModule';

/**
 * The alarm site + module dimension on real Postgres (ALERT-MEDIUM-010), run
 * the way the orchestrator runs it: once per schema, search_path pinned, as a
 * role without BYPASSRLS on tables whose tenant-isolation policy is FORCED.
 *
 * A tenant schema gains the nullable columns and their indexes; historic rows
 * get a module and a site only where their provenance states one (a sensor's
 * site, a site the farm signal carried, a day plan's or a measurement's site)
 * and stay NULL otherwise. The source `alert` schema gets the columns and no
 * backfill; a tenant without the farm or sensor module gets what applies to
 * it; re-running is a no-op; `down` removes the columns.
 */

const TENANT = '5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f';
const SITE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SITE_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const SITE_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const SITE_D = '0d0d0d0d-0000-4000-8000-00000000000d';
const SITE_E = '0e0e0e0e-0000-4000-8000-00000000000e';
const SENSOR_ON_SITE = '1a000000-0000-4000-8000-000000000001';
const SENSOR_NO_SITE = '1a000000-0000-4000-8000-000000000002';
const DAY_PLAN = '2b000000-0000-4000-8000-000000000001';
const MEASUREMENT = '3c000000-0000-4000-8000-000000000001';
const MIGRATOR = 'alert_test_migrator';

/** Mirrors apply-tenant-rls.helper: bypass GUC or the bound tenant, FORCED. */
const TENANT_POLICY = `USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
)`;

jest.setTimeout(180_000);

describe('AddAlertHistorySiteAndModule1801200000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);
  const bare = 'tenant_00000000000000bb';

  async function createAlertHistory(target: string): Promise<void> {
    await admin!.query(`
      CREATE TABLE "${target}".alert_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id varchar NOT NULL,
        tenant_id uuid NOT NULL,
        sensor_id varchar,
        triggering_data jsonb NOT NULL,
        triggered_at timestamptz NOT NULL DEFAULT now()
      )`);
    await forceTenantPolicy(`"${target}".alert_history`);
  }

  async function forceTenantPolicy(table: string): Promise<void> {
    await admin!.query(`ALTER TABLE ${table} OWNER TO ${MIGRATOR}`);
    await admin!.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await admin!.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await admin!.query(`CREATE POLICY tenant_isolation_policy ON ${table} ${TENANT_POLICY}`);
  }

  async function alarm(
    target: string,
    ruleId: string,
    data: object,
    sensorId?: string,
  ): Promise<void> {
    await admin!.query(
      `INSERT INTO "${target}".alert_history (rule_id, tenant_id, sensor_id, triggering_data)
       VALUES ($1, $2, $3, $4)`,
      [ruleId, TENANT, sensorId ?? null, JSON.stringify(data)],
    );
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const target of ['alert', schema, bare]) {
      await admin.query(`CREATE SCHEMA "${target}"`);
      await admin.query(`GRANT ALL ON SCHEMA "${target}" TO ${MIGRATOR}`);
      await createAlertHistory(target);
    }

    // Sibling modules' tables in the same tenant schema (sensor + farm).
    await admin.query(
      `CREATE TABLE "${schema}".sensors (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, site_id varchar)`,
    );
    await forceTenantPolicy(`"${schema}".sensors`);
    await admin.query(`INSERT INTO "${schema}".sensors VALUES ($1, $3, $4), ($2, $3, NULL)`, [
      SENSOR_ON_SITE,
      SENSOR_NO_SITE,
      TENANT,
      SITE_A,
    ]);
    await admin.query(
      `CREATE TABLE "${schema}".feeding_day_plans (id uuid PRIMARY KEY, "siteId" uuid NOT NULL)`,
    );
    await admin.query(`INSERT INTO "${schema}".feeding_day_plans VALUES ($1, $2)`, [
      DAY_PLAN,
      SITE_D,
    ]);
    await admin.query(
      `CREATE TABLE "${schema}".water_quality_measurements (id uuid PRIMARY KEY, "siteId" uuid)`,
    );
    await admin.query(`INSERT INTO "${schema}".water_quality_measurements VALUES ($1, $2)`, [
      MEASUREMENT,
      SITE_E,
    ]);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${MIGRATOR}`);

    await alarm(schema, 'rule-uuid-1', { sensorId: SENSOR_ON_SITE }, SENSOR_ON_SITE);
    await alarm(schema, 'rule-uuid-2', { sensorId: SENSOR_NO_SITE }, SENSOR_NO_SITE);
    await alarm(schema, 'system:unfed-unit:u1', { siteId: SITE_B });
    await alarm(schema, `system:feed-stockout:${SITE_C}:f1`, { siteScopeKey: SITE_C });
    await alarm(schema, 'system:feed-stockout:tenant:f1', { siteScopeKey: 'tenant' });
    await alarm(schema, 'system:meal-missed:u1', { dayPlanId: DAY_PLAN });
    await alarm(schema, 'system:feeding-window-oxygen:u1', { dayPlanId: DAY_PLAN });
    await alarm(schema, 'system:water-quality:t1', { measurementId: MEASUREMENT });
    await alarm(schema, 'system:mortality:daily_rate', { batchId: 'b1' });
    await alarm(schema, 'legacy-rule', {});
    await alarm(bare, 'system:unfed-unit:u2', { siteId: SITE_B });
    await alarm(bare, 'system:meal-missed:u2', { dayPlanId: DAY_PLAN });
    await alarm('alert', 'rule-uuid-1', {}, SENSOR_ON_SITE);
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function asMigrator(
    target: string,
    run: (qr: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const qr = admin!.createQueryRunner();
    await qr.query(`SET search_path TO "${target}", public`);
    await qr.query(`SET ROLE ${MIGRATOR}`);
    try {
      await qr.startTransaction();
      await run(qr);
      await qr.commitTransaction();
    } catch (error) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.query('RESET ROLE');
      await qr.release();
    }
  }

  async function rows(target: string): Promise<Record<string, string | null>> {
    const result: Array<{ rule_id: string; site_id: string | null; module: string | null }> =
      await admin!.query(`SELECT rule_id, site_id, "module" FROM "${target}".alert_history`);
    return Object.fromEntries(
      result.map((row) => [row.rule_id, `${row.module ?? 'NULL'}@${row.site_id ?? 'NULL'}`]),
    );
  }

  it('adds the nullable columns and indexes, idempotently', async () => {
    const migration = new AddAlertHistorySiteAndModule1801200000000();
    await asMigrator(schema, (qr) => migration.up(qr));
    await asMigrator(schema, (qr) => migration.up(qr));

    const columns = await admin!.query(
      `SELECT column_name, is_nullable, udt_schema, udt_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'alert_history'
          AND column_name IN ('site_id', 'module') ORDER BY column_name`,
      [schema],
    );
    expect(columns).toEqual([
      {
        column_name: 'module',
        is_nullable: 'YES',
        udt_schema: schema,
        udt_name: 'alert_history_module_enum',
      },
      { column_name: 'site_id', is_nullable: 'YES', udt_schema: 'pg_catalog', udt_name: 'uuid' },
    ]);
    const indexes: Array<{ indexname: string }> = await admin!.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'alert_history'
        AND indexname LIKE 'IDX_alert_history_%' ORDER BY indexname`,
      [schema],
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'IDX_alert_history_module_triggered_at',
      'IDX_alert_history_site_id_triggered_at',
    ]);
  });

  it('backfills module and site only where the row’s provenance states them, under forced RLS', async () => {
    expect(await rows(schema)).toEqual({
      'rule-uuid-1': `sensor@${SITE_A}`,
      // The sensor has no site: the module is known, the site is not.
      'rule-uuid-2': 'sensor@NULL',
      'system:unfed-unit:u1': `farm@${SITE_B}`,
      [`system:feed-stockout:${SITE_C}:f1`]: `farm@${SITE_C}`,
      // The tenant-wide stock pool names no site.
      'system:feed-stockout:tenant:f1': 'farm@NULL',
      'system:meal-missed:u1': `farm@${SITE_D}`,
      'system:feeding-window-oxygen:u1': `sensor@${SITE_D}`,
      'system:water-quality:t1': `farm@${SITE_E}`,
      // A mortality incident spans the tenant; its rows carry no site.
      'system:mortality:daily_rate': 'farm@NULL',
      // Neither a sensor reading nor a known farm signal: left unattributed.
      'legacy-rule': 'NULL@NULL',
    });
  });

  it('leaves the bypass off for the rest of the transaction', async () => {
    let after: Array<{ bypass: string | null }> = [];
    await asMigrator(schema, async (qr) => {
      await new AddAlertHistorySiteAndModule1801200000000().up(qr);
      after = await qr.query(`SELECT current_setting('app.bypass_rls', true) AS bypass`);
    });
    expect(after).toEqual([{ bypass: 'off' }]);
  });

  it('backfills what applies in a tenant without the farm or sensor module', async () => {
    await asMigrator(bare, (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr));
    expect(await rows(bare)).toEqual({
      'system:unfed-unit:u2': `farm@${SITE_B}`,
      // No feeding_day_plans here: the module is known, the site is not.
      'system:meal-missed:u2': 'farm@NULL',
    });
  });

  it('adds the columns to the source schema without backfilling its template', async () => {
    await asMigrator('alert', (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr));
    expect(await rows('alert')).toEqual({ 'rule-uuid-1': 'NULL@NULL' });
  });

  it('removes the columns on down', async () => {
    await asMigrator(bare, (qr) => new AddAlertHistorySiteAndModule1801200000000().down(qr));
    const columns = await admin!.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'alert_history'
          AND column_name IN ('site_id', 'module')`,
      [bare],
    );
    expect(columns).toEqual([]);
  });
});
