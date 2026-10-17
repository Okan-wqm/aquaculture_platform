import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddAlertHistorySiteAndModule1801200000000 } from '../1801200000000-AddAlertHistorySiteAndModule';

/**
 * The alarm site + module columns on real Postgres (ALERT-MEDIUM-010), run
 * the way the runners run it: once per schema, search_path pinned, inside
 * the per-migration transaction, as a role without BYPASSRLS.
 *
 * A tenant schema and the source `alert` schema gain the nullable columns and
 * their indexes; re-running is a no-op; `down` removes them. The migration is
 * DDL only and short (ALERT-MEDIUM-011): it bounds its own lock wait and
 * statement time, fails fast instead of queueing behind a live alarm
 * transaction, and writes no row — 1801300000000 attributes historic rows.
 */

const TENANT = '5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f';
const SENSOR = '1a000000-0000-4000-8000-000000000001';
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

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const target of ['alert', schema]) {
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
      await admin.query(`ALTER TABLE "${target}".alert_history OWNER TO ${MIGRATOR}`);
      await admin.query(`ALTER TABLE "${target}".alert_history ENABLE ROW LEVEL SECURITY`);
      await admin.query(`ALTER TABLE "${target}".alert_history FORCE ROW LEVEL SECURITY`);
      await admin.query(
        `CREATE POLICY tenant_isolation_policy ON "${target}".alert_history ${TENANT_POLICY}`,
      );
    }
    // A historic sensor-rule alarm: this migration must leave it unattributed.
    await admin.query(
      `INSERT INTO "${schema}".alert_history (rule_id, tenant_id, sensor_id, triggering_data)
       VALUES ('rule-uuid-1', $1, $2, '{}')`,
      [TENANT, SENSOR],
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

  async function columns(target: string): Promise<string[]> {
    const rows: Array<{ column_name: string }> = await admin!.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'alert_history'
          AND column_name IN ('site_id', 'module') ORDER BY column_name`,
      [target],
    );
    return rows.map((row) => row.column_name);
  }

  it('adds the nullable columns and indexes, idempotently', async () => {
    const migration = new AddAlertHistorySiteAndModule1801200000000();
    await asMigrator(schema, (qr) => migration.up(qr));
    await asMigrator(schema, (qr) => migration.up(qr));

    const added = await admin!.query(
      `SELECT column_name, is_nullable, udt_schema, udt_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'alert_history'
          AND column_name IN ('site_id', 'module') ORDER BY column_name`,
      [schema],
    );
    expect(added).toEqual([
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

  it('writes no row: historic alarms are attributed by 1801300000000', async () => {
    const rows: Array<{ module: string | null; site_id: string | null }> = await admin!.query(
      `SELECT "module", site_id FROM "${schema}".alert_history`,
    );
    expect(rows).toEqual([{ module: null, site_id: null }]);
  });

  it('bounds its own lock wait and statement time, for its transaction only (ALERT-MEDIUM-011)', async () => {
    const settings = await asMigrator(schema, async (qr) => {
      await new AddAlertHistorySiteAndModule1801200000000().up(qr);
      const [row]: Array<{ lock: string; statement: string }> = await qr.query(
        `SELECT current_setting('lock_timeout') AS lock,
                current_setting('statement_timeout') AS statement`,
      );
      return row;
    });
    expect(settings).toEqual({ lock: '2s', statement: '30s' });

    const [after]: Array<{ lock: string }> = await admin!.query(
      `SELECT current_setting('lock_timeout') AS lock`,
    );
    expect(after).toEqual({ lock: '0' });
  });

  it('fails fast instead of queueing behind a live transaction on the table (ALERT-MEDIUM-011)', async () => {
    await asMigrator(schema, (qr) => new AddAlertHistorySiteAndModule1801200000000().down(qr));

    // A live reader holds ACCESS SHARE until it commits; ADD COLUMN needs
    // ACCESS EXCLUSIVE and must give up after lock_timeout, not wait.
    const reader = admin!.createQueryRunner();
    await reader.startTransaction();
    await reader.query(`SELECT count(*) FROM "${schema}".alert_history`);
    try {
      const started = Date.now();
      await expect(
        asMigrator(schema, (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr)),
      ).rejects.toMatchObject({ driverError: { code: '55P03' } });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await reader.rollbackTransaction();
      await reader.release();
    }
    // The whole migration rolled back: no half-added column.
    expect(await columns(schema)).toEqual([]);

    await asMigrator(schema, (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr));
    expect(await columns(schema)).toEqual(['module', 'site_id']);
  });

  it('adds the columns to the source schema too', async () => {
    await asMigrator('alert', (qr) => new AddAlertHistorySiteAndModule1801200000000().up(qr));
    expect(await columns('alert')).toEqual(['module', 'site_id']);
  });

  it('removes the columns on down', async () => {
    await asMigrator('alert', (qr) => new AddAlertHistorySiteAndModule1801200000000().down(qr));
    expect(await columns('alert')).toEqual([]);
  });
});
