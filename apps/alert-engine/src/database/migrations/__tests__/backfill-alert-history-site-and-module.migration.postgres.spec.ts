import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddAlertHistorySiteAndModule1801200000000 } from '../1801200000000-AddAlertHistorySiteAndModule';
import {
  ALERT_HISTORY_BACKFILL_BATCH_SIZE,
  BackfillAlertHistorySiteAndModule1801300000000,
} from '../1801300000000-BackfillAlertHistorySiteAndModule';

/**
 * The alarm site + module backfill on real Postgres (ALERT-MEDIUM-010), run
 * the way the runners run a `transaction = false` migration: once per schema,
 * search_path pinned, no wrapper transaction, as a role without BYPASSRLS on
 * tables whose tenant-isolation policy is FORCED.
 *
 * Exact or nothing (ALERT-LOW-012): a row gets a site only from the source the
 * live path stamps — the signal's own site, a site scope key, the day plan's,
 * the measurement's — and a sensor-rule or oxygen-guard row keeps its site
 * NULL. In batches that each commit (ALERT-MEDIUM-011): a batch waits at most
 * lock_timeout for a live row lock, a run stopped there keeps the batches it
 * committed, and a re-run completes the rest.
 */

const TENANT = '5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f';
const SITE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SITE_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const SITE_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const SITE_D = '0d0d0d0d-0000-4000-8000-00000000000d';
const SITE_E = '0e0e0e0e-0000-4000-8000-00000000000e';
const SENSOR_ON_SITE = '1a000000-0000-4000-8000-000000000001';
const DAY_PLAN = '2b000000-0000-4000-8000-000000000001';
const GONE_DAY_PLAN = '2b000000-0000-4000-8000-0000000000ff';
const MEASUREMENT = '3c000000-0000-4000-8000-000000000001';
const MIGRATOR = 'alert_backfill_migrator';
/** Three batches: two full, one of a single row. */
const LARGE_ROWS = 2 * ALERT_HISTORY_BACKFILL_BATCH_SIZE + 1;

/** Mirrors apply-tenant-rls.helper: bypass GUC or the bound tenant, FORCED. */
const TENANT_POLICY = `USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
)`;

jest.setTimeout(240_000);

describe('BackfillAlertHistorySiteAndModule1801300000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);
  const bare = 'tenant_00000000000000bb';
  const large = 'tenant_00000000000000cc';

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
    stamped: { sensorId?: string; module?: string; siteId?: string } = {},
  ): Promise<void> {
    await admin!.query(
      `INSERT INTO "${target}".alert_history
         (rule_id, tenant_id, sensor_id, triggering_data, "module", site_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ruleId,
        TENANT,
        stamped.sensorId ?? null,
        JSON.stringify(data),
        stamped.module ?? null,
        stamped.siteId ?? null,
      ],
    );
  }

  /** The runners' shape for this migration: pinned search_path, migrator role, no transaction. */
  async function backfill(target: string): Promise<void> {
    const qr = admin!.createQueryRunner();
    await qr.query(`SET search_path TO "${target}", public`);
    await qr.query(`SET ROLE ${MIGRATOR}`);
    try {
      await new BackfillAlertHistorySiteAndModule1801300000000().up(qr);
    } finally {
      await qr.query('RESET ROLE');
      await qr.release();
    }
  }

  async function inTransaction(
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

  async function rows(target: string): Promise<Record<string, string>> {
    const result: Array<{ rule_id: string; site_id: string | null; module: string | null }> =
      await admin!.query(`SELECT rule_id, site_id, "module" FROM "${target}".alert_history`);
    return Object.fromEntries(
      result.map((row) => [row.rule_id, `${row.module ?? 'NULL'}@${row.site_id ?? 'NULL'}`]),
    );
  }

  async function versions(target: string): Promise<Record<string, string>> {
    const result: Array<{ id: string; version: string }> = await admin!.query(
      `SELECT id, xmin::text AS version FROM "${target}".alert_history`,
    );
    return Object.fromEntries(result.map((row) => [row.id, row.version]));
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const target of ['alert', schema, bare, large]) {
      await admin.query(`CREATE SCHEMA "${target}"`);
      await admin.query(`GRANT ALL ON SCHEMA "${target}" TO ${MIGRATOR}`);
      await admin.query(`
        CREATE TABLE "${target}".alert_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          rule_id varchar NOT NULL,
          tenant_id uuid NOT NULL,
          sensor_id varchar,
          triggering_data jsonb NOT NULL,
          triggered_at timestamptz NOT NULL DEFAULT now()
        )`);
      await forceTenantPolicy(`"${target}".alert_history`);
      await inTransaction(target, (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr));
    }

    // Sibling modules' tables in the tenant schema (sensor + farm).
    await admin.query(
      `CREATE TABLE "${schema}".sensors (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, site_id varchar)`,
    );
    await forceTenantPolicy(`"${schema}".sensors`);
    await admin.query(`INSERT INTO "${schema}".sensors VALUES ($1, $2, $3)`, [
      SENSOR_ON_SITE,
      TENANT,
      SITE_A,
    ]);
    await admin.query(
      `CREATE TABLE "${schema}".feeding_day_plans (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, "siteId" uuid NOT NULL)`,
    );
    await forceTenantPolicy(`"${schema}".feeding_day_plans`);
    await admin.query(`INSERT INTO "${schema}".feeding_day_plans VALUES ($1, $2, $3)`, [
      DAY_PLAN,
      TENANT,
      SITE_D,
    ]);
    await admin.query(
      `CREATE TABLE "${schema}".water_quality_measurements (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, "siteId" uuid)`,
    );
    await forceTenantPolicy(`"${schema}".water_quality_measurements`);
    await admin.query(`INSERT INTO "${schema}".water_quality_measurements VALUES ($1, $2, $3)`, [
      MEASUREMENT,
      TENANT,
      SITE_E,
    ]);

    await alarm(schema, 'rule-uuid-1', { sensorId: SENSOR_ON_SITE }, { sensorId: SENSOR_ON_SITE });
    await alarm(schema, 'system:unfed-unit:u1', { siteId: SITE_B });
    await alarm(schema, `system:feed-stockout:${SITE_C}:f1`, { siteScopeKey: SITE_C });
    await alarm(schema, `system:feed-transition-gap:${SITE_C}:f2`, { siteScopeKey: SITE_C });
    await alarm(schema, 'system:feed-stockout:tenant:f1', { siteScopeKey: 'tenant' });
    await alarm(schema, 'system:meal-missed:u1', { dayPlanId: DAY_PLAN });
    await alarm(schema, 'system:meal-underfed:u1', { dayPlanId: DAY_PLAN });
    await alarm(schema, 'system:meal-missed:gone', { dayPlanId: GONE_DAY_PLAN });
    await alarm(schema, 'system:meal-missed:malformed', { dayPlanId: 'not-a-uuid' });
    await alarm(schema, 'system:feeding-window-oxygen:u1', { dayPlanId: DAY_PLAN });
    await alarm(schema, 'system:water-quality:t1', { measurementId: MEASUREMENT });
    await alarm(schema, 'system:mortality:daily_rate', { batchId: 'b1' });
    await alarm(schema, 'legacy-rule', {});
    // Written by the new release while the old rows wait: never overwritten.
    await alarm(
      schema,
      'system:unfed-unit:live',
      { siteId: SITE_B },
      { module: 'farm', siteId: SITE_A },
    );
    await alarm(bare, 'system:unfed-unit:u2', { siteId: SITE_B });
    await alarm(bare, 'system:meal-missed:u2', { dayPlanId: DAY_PLAN });
    await alarm('alert', 'system:unfed-unit:template', { siteId: SITE_B });
    await admin.query(
      `INSERT INTO "${large}".alert_history (rule_id, tenant_id, triggering_data)
       SELECT 'system:unfed-unit:' || n, $1, jsonb_build_object('siteId', $2::text)
         FROM generate_series(1, $3) AS n`,
      [TENANT, SITE_B, LARGE_ROWS],
    );
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  it('gives each row exactly what its provenance states, under forced RLS', async () => {
    await backfill(schema);

    expect(await rows(schema)).toEqual({
      // The live path stamps the sensor's site at reading time; only its
      // current site is on record, so the site stays unknown.
      'rule-uuid-1': 'sensor@NULL',
      'system:unfed-unit:u1': `farm@${SITE_B}`,
      [`system:feed-stockout:${SITE_C}:f1`]: `farm@${SITE_C}`,
      [`system:feed-transition-gap:${SITE_C}:f2`]: `farm@${SITE_C}`,
      // The tenant-wide stock pool names no site.
      'system:feed-stockout:tenant:f1': 'farm@NULL',
      'system:meal-missed:u1': `farm@${SITE_D}`,
      'system:meal-underfed:u1': `farm@${SITE_D}`,
      'system:meal-missed:gone': 'farm@NULL',
      'system:meal-missed:malformed': 'farm@NULL',
      // The live path stamps the DO sensor's site, which the row does not name.
      'system:feeding-window-oxygen:u1': 'sensor@NULL',
      'system:water-quality:t1': `farm@${SITE_E}`,
      // A mortality incident spans the tenant; its rows carry no site.
      'system:mortality:daily_rate': 'farm@NULL',
      // Neither a sensor reading nor a known farm signal: left unattributed.
      'legacy-rule': 'NULL@NULL',
      'system:unfed-unit:live': `farm@${SITE_A}`,
    });
  });

  it('writes nothing on a re-run', async () => {
    const before = await versions(schema);
    await backfill(schema);
    expect(await versions(schema)).toEqual(before);
  });

  it('attributes what applies in a tenant without the farm module', async () => {
    await backfill(bare);
    expect(await rows(bare)).toEqual({
      'system:unfed-unit:u2': `farm@${SITE_B}`,
      // No feeding_day_plans here: the module is known, the site is not.
      'system:meal-missed:u2': 'farm@NULL',
    });
  });

  it('leaves the source schema’s template rows alone', async () => {
    await backfill('alert');
    expect(await rows('alert')).toEqual({ 'system:unfed-unit:template': 'NULL@NULL' });
  });

  it('refuses to run inside a transaction it cannot commit batch by batch', async () => {
    await expect(
      inTransaction(schema, (qr) => new BackfillAlertHistorySiteAndModule1801300000000().up(qr)),
    ).rejects.toThrow(/must run outside a transaction/);
  });

  it('leaves no transaction open and no RLS bypass behind', async () => {
    const qr = admin!.createQueryRunner();
    await qr.query(`SET search_path TO "${schema}", public`);
    await qr.query(`SET ROLE ${MIGRATOR}`);
    try {
      await new BackfillAlertHistorySiteAndModule1801300000000().up(qr);
      expect(qr.isTransactionActive).toBe(false);
      const [setting]: Array<{ bypass: string | null }> = await qr.query(
        `SELECT current_setting('app.bypass_rls', true) AS bypass`,
      );
      expect(setting).not.toEqual({ bypass: 'on' });
    } finally {
      await qr.query('RESET ROLE');
      await qr.release();
    }
  });

  describe('a large table (ALERT-MEDIUM-011)', () => {
    it('stops at lock_timeout behind a live row lock, keeping the batches it committed', async () => {
      // A live acknowledgement holds one row of the second batch.
      const [held]: Array<{ id: string }> = await admin!.query(
        `SELECT id FROM "${large}".alert_history ORDER BY id OFFSET $1 LIMIT 1`,
        [ALERT_HISTORY_BACKFILL_BATCH_SIZE + 10],
      );
      const live = admin!.createQueryRunner();
      await live.startTransaction();
      await live.query(`SELECT 1 FROM "${large}".alert_history WHERE id = $1 FOR UPDATE`, [
        held!.id,
      ]);
      try {
        const started = Date.now();
        await expect(backfill(large)).rejects.toMatchObject({ driverError: { code: '55P03' } });
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        await live.rollbackTransaction();
        await live.release();
      }

      const [done]: Array<{ attributed: number }> = await admin!.query(
        `SELECT count(*)::int AS attributed FROM "${large}".alert_history WHERE site_id IS NOT NULL`,
      );
      expect(done).toEqual({ attributed: ALERT_HISTORY_BACKFILL_BATCH_SIZE });
    });

    it('completes on a re-run, every batch in a transaction of its own', async () => {
      await backfill(large);

      const [summary]: Array<{ attributed: number; transactions: number }> = await admin!.query(
        `SELECT count(*) FILTER (WHERE "module" = 'farm' AND site_id = $1)::int AS attributed,
                count(DISTINCT xmin::text)::int AS transactions
           FROM "${large}".alert_history`,
        [SITE_B],
      );
      expect(summary).toEqual({ attributed: LARGE_ROWS, transactions: 3 });
    });
  });

  it('down is a no-op: the columns and their values go with 1801200000000', async () => {
    const before = await rows(schema);
    await inTransaction(schema, () => new BackfillAlertHistorySiteAndModule1801300000000().down());
    expect(await rows(schema)).toEqual(before);
  });
});
