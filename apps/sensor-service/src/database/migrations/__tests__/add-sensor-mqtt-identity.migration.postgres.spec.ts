import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddSensorMqttIdentity1826000000000 } from '../1826000000000-AddSensorMqttIdentity';

/**
 * The sensor broker-principal migration on real Postgres, run the way the
 * orchestrator runs it: the `sensor` source pass first, then each schema with
 * the search_path pinned, under db-migrate's DDL authority. Re-running is a
 * no-op; a schema without the sensors table is skipped; the triggers unroute a
 * username on rotation, clear and delete and refuse at commit a username no
 * route holds; the checks keep it to its shape, off children and off
 * suspended sensors; `down` removes everything.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const USERNAME = `s${'a'.repeat(22)}`;
const ROTATED = `s${'b'.repeat(22)}`;

jest.setTimeout(180_000);

describe('AddSensorMqttIdentity1826000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);
  const migration = new AddSensorMqttIdentity1826000000000();

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE SCHEMA sensor`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
      CREATE TABLE "${schema}".sensors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        parent_id uuid,
        registration_status varchar NOT NULL DEFAULT 'draft'
      )`);
    await admin.query(`CREATE SCHEMA "empty_schema"`);
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function pass(target: string, run: (qr: QueryRunner) => Promise<void>): Promise<void> {
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    const qr = admin!.createQueryRunner();
    try {
      await qr.query(`SET search_path TO "${target}", public`);
      await qr.startTransaction();
      await run(qr);
      await qr.commitTransaction();
    } finally {
      await qr.release();
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
  }

  async function columns(): Promise<string[]> {
    const rows: Array<{ column_name: string }> = await admin!.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sensors' AND column_name LIKE 'mqtt_%'
        ORDER BY column_name`,
      [schema],
    );
    return rows.map((row) => row.column_name);
  }

  async function routed(): Promise<Array<{ mqtt_username: string }>> {
    // The superuser bypasses the directory's FORCE RLS: it sees every route.
    return admin!.query(`SELECT mqtt_username FROM sensor.sensor_mqtt_directory`);
  }

  /** Run statements in one transaction; the commit's error message, or null when it committed. */
  async function inOneTransaction(statements: Array<[string, unknown[]]>): Promise<string | null> {
    const qr = admin!.createQueryRunner();
    try {
      await qr.startTransaction();
      for (const [sql, params] of statements) {
        await qr.query(sql, params);
      }
      await qr.commitTransaction();
      return null;
    } catch (error) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      return error instanceof Error ? error.message : String(error);
    } finally {
      await qr.release();
    }
  }

  async function newSensor(): Promise<string> {
    const [row] = await admin!.query(
      `INSERT INTO "${schema}".sensors (tenant_id) VALUES ($1) RETURNING id`,
      [TENANT],
    );
    return row.id;
  }

  /** The two writes of an issue, as SensorMqttIdentityService makes them. */
  const issue = (sensorId: string, username: string): Array<[string, unknown[]]> => [
    [`UPDATE "${schema}".sensors SET mqtt_username = $2 WHERE id = $1`, [sensorId, username]],
    [
      `INSERT INTO sensor.sensor_mqtt_directory
         (mqtt_username, sensor_id, tenant_id, secret_hmac, secret_key_id)
       VALUES ($1, $2, $3, $4, 'k1')`,
      [username, sensorId, TENANT, 'e'.repeat(64)],
    ],
  ];

  it('adds the column, the directory and the triggers, idempotently', async () => {
    for (let run = 0; run < 2; run += 1) {
      await pass('sensor', (qr) => migration.up(qr));
      await pass(schema, (qr) => migration.up(qr));
    }
    expect(await columns()).toEqual(['mqtt_username']);
    const [rls] = await admin!.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'sensor.sensor_mqtt_directory'::regclass`,
    );
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const triggers: Array<{ tgname: string; atCommit: boolean }> = await admin!.query(
      `SELECT tgname, tginitdeferred AS "atCommit" FROM pg_trigger
        WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
      [`"${schema}".sensors`],
    );
    expect(triggers).toEqual([
      { tgname: 'TRG_sensors_mqtt_routed', atCommit: true },
      { tgname: 'TRG_sensors_mqtt_unroute', atCommit: false },
    ]);
  });

  it('skips a schema that has no sensors table', async () => {
    await expect(pass('empty_schema', (qr) => migration.up(qr))).resolves.toBeUndefined();
  });

  it('commits an issue, unroutes the old username on rotation, and unroutes on clear and delete', async () => {
    const sensor = await newSensor();

    await expect(inOneTransaction(issue(sensor, USERNAME))).resolves.toBeNull();
    expect(await routed()).toEqual([{ mqtt_username: USERNAME }]);
    await expect(inOneTransaction(issue(sensor, ROTATED))).resolves.toBeNull();
    expect(await routed()).toEqual([{ mqtt_username: ROTATED }]);
    await admin!.query(`UPDATE "${schema}".sensors SET mqtt_username = NULL WHERE id = $1`, [
      sensor,
    ]);
    expect(await routed()).toEqual([]);

    await expect(inOneTransaction(issue(sensor, USERNAME))).resolves.toBeNull();
    await admin!.query(`DELETE FROM "${schema}".sensors WHERE id = $1`, [sensor]);
    expect(await routed()).toEqual([]);
  });

  it('refuses at commit a username no route holds for that sensor', async () => {
    const sensor = await newSensor();
    const other = await newSensor();

    await expect(inOneTransaction([issue(sensor, USERNAME)[0]!])).resolves.toMatch(
      /no route holds/,
    );
    // A route held by another sensor is no route for this one.
    await expect(
      inOneTransaction([issue(sensor, USERNAME)[0]!, issue(other, USERNAME)[1]!]),
    ).resolves.toMatch(/no route holds/);
    expect(await routed()).toEqual([]);
  });

  it('refuses a misshapen username, one on a child and one on a suspended sensor', async () => {
    const parent = await newSensor();
    const [child] = await admin!.query(
      `INSERT INTO "${schema}".sensors (tenant_id, parent_id) VALUES ($1, $2) RETURNING id`,
      [TENANT, parent],
    );
    await expect(inOneTransaction(issue(parent, 'edge-device-1'))).resolves.toMatch(
      /CHK_sensors_mqtt_username_shape/,
    );
    await expect(inOneTransaction(issue(child.id, USERNAME))).resolves.toMatch(
      /CHK_sensors_mqtt_identity_principal/,
    );
    await admin!.query(
      `UPDATE "${schema}".sensors SET registration_status = 'suspended' WHERE id = $1`,
      [parent],
    );
    await expect(inOneTransaction(issue(parent, USERNAME))).resolves.toMatch(
      /CHK_sensors_mqtt_identity_not_suspended/,
    );
  });

  it('down removes the triggers, the column, the directory and the functions', async () => {
    await pass(schema, (qr) => migration.down(qr));
    await pass('sensor', (qr) => migration.down(qr));
    expect(await columns()).toEqual([]);
    const [left] = await admin!.query(
      `SELECT to_regclass('sensor.sensor_mqtt_directory') AS directory,
              to_regprocedure('sensor.unroute_sensor_mqtt_username()') AS unroute,
              to_regprocedure('sensor.assert_sensor_mqtt_routed()') AS routed`,
    );
    expect(left).toEqual({ directory: null, unroute: null, routed: null });
  });
});
