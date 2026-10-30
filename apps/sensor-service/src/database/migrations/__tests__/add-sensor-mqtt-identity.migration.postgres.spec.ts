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
 * no-op; a schema without the sensors table is skipped; the trigger routes a
 * username and unroutes it on rotation and delete; `down` removes everything.
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
        parent_id uuid
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

  it('adds the columns, the directory and the trigger, idempotently', async () => {
    for (let run = 0; run < 2; run += 1) {
      await pass('sensor', (qr) => migration.up(qr));
      await pass(schema, (qr) => migration.up(qr));
    }
    expect(await columns()).toEqual(['mqtt_secret_hmac', 'mqtt_secret_key_id', 'mqtt_username']);
    const [rls] = await admin!.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'sensor.sensor_mqtt_directory'::regclass`,
    );
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('skips a schema that has no sensors table', async () => {
    await expect(pass('empty_schema', (qr) => migration.up(qr))).resolves.toBeUndefined();
  });

  it('routes a username, re-routes it on rotation and unroutes it on delete', async () => {
    const [row] = await admin!.query(
      `INSERT INTO "${schema}".sensors (tenant_id) VALUES ($1) RETURNING id`,
      [TENANT],
    );
    const issue = (username: string): Promise<unknown> =>
      admin!.query(
        `UPDATE "${schema}".sensors
            SET mqtt_username = $2, mqtt_secret_hmac = $3, mqtt_secret_key_id = 'k1'
          WHERE id = $1`,
        [row.id, username, 'e'.repeat(64)],
      );

    await issue(USERNAME);
    expect(await routed()).toEqual([{ mqtt_username: USERNAME }]);
    await issue(ROTATED);
    expect(await routed()).toEqual([{ mqtt_username: ROTATED }]);
    await admin!.query(`DELETE FROM "${schema}".sensors WHERE id = $1`, [row.id]);
    expect(await routed()).toEqual([]);
  });

  it('refuses a partial or misshapen credential', async () => {
    const [row] = await admin!.query(
      `INSERT INTO "${schema}".sensors (tenant_id) VALUES ($1) RETURNING id`,
      [TENANT],
    );
    await expect(
      admin!.query(`UPDATE "${schema}".sensors SET mqtt_username = $2 WHERE id = $1`, [
        row.id,
        USERNAME,
      ]),
    ).rejects.toThrow(/CHK_sensors_mqtt_identity_complete/);
    await expect(
      admin!.query(
        `UPDATE "${schema}".sensors
            SET mqtt_username = 'edge-device-1', mqtt_secret_hmac = $2, mqtt_secret_key_id = 'k1'
          WHERE id = $1`,
        [row.id, 'e'.repeat(64)],
      ),
    ).rejects.toThrow(/CHK_sensors_mqtt_identity_shape/);
  });

  it('down removes the trigger, the columns, the directory and the function', async () => {
    await pass(schema, (qr) => migration.down(qr));
    await pass('sensor', (qr) => migration.down(qr));
    expect(await columns()).toEqual([]);
    const [left] = await admin!.query(
      `SELECT to_regclass('sensor.sensor_mqtt_directory') AS directory,
              to_regprocedure('sensor.sync_sensor_mqtt_directory()') AS fn`,
    );
    expect(left).toEqual({ directory: null, fn: null });
  });
});
