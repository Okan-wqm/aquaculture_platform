import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddCommandActorEmails1824000000000 } from '../1824000000000-AddCommandActorEmails';

/**
 * The actor e-mail columns of the two command records on real Postgres, run
 * the way the orchestrator runs it: once per schema with the search_path
 * pinned. A tenant schema gains `deployment_logs.deployed_by_email` and
 * `feeding_parameters."createdByEmail"` as nullable columns without touching
 * existing rows (their actor stays the recorded id); re-running is a no-op; a
 * schema with only one of the tables, or neither, gets what applies to it;
 * `down` removes both.
 */

const TENANT = '0c4d6b1e-5a7f-4f0e-9a3b-2d8c6e1f4a90';

jest.setTimeout(180_000);

describe('AddCommandActorEmails1824000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
      CREATE TABLE "${schema}".deployment_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        deployed_by varchar
      )`);
    await admin.query(`
      CREATE TABLE "${schema}".feeding_parameters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        "createdBy" varchar
      )`);
    await admin.query(
      `INSERT INTO "${schema}".deployment_logs (tenant_id, deployed_by) VALUES ($1, gen_random_uuid()::text)`,
      [TENANT],
    );
    await admin.query(
      `INSERT INTO "${schema}".feeding_parameters (tenant_id, "createdBy") VALUES ($1, gen_random_uuid()::text)`,
      [TENANT],
    );
    await admin.query(`CREATE SCHEMA "feeding_only"`);
    await admin.query(`CREATE TABLE "feeding_only".feeding_parameters (id uuid PRIMARY KEY)`);
    await admin.query(`CREATE SCHEMA "empty_schema"`);
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function inSchema(target: string, run: (qr: QueryRunner) => Promise<void>): Promise<void> {
    const qr = admin!.createQueryRunner();
    try {
      await qr.query(`SET search_path TO "${target}", public`);
      await qr.startTransaction();
      await run(qr);
      await qr.commitTransaction();
    } finally {
      await qr.release();
    }
  }

  async function columns(
    target: string,
  ): Promise<
    Array<{ table_name: string; column_name: string; is_nullable: string; type: string }>
  > {
    return admin!.query(
      `SELECT table_name, column_name, is_nullable,
              data_type || '(' || character_maximum_length || ')' AS type
         FROM information_schema.columns
        WHERE table_schema = $1
          AND (table_name, column_name) IN (('deployment_logs', 'deployed_by_email'),
                                            ('feeding_parameters', 'createdByEmail'))
        ORDER BY table_name`,
      [target],
    );
  }

  it('adds both nullable e-mail columns and leaves existing rows without one, idempotently', async () => {
    const migration = new AddCommandActorEmails1824000000000();
    await inSchema(schema, (qr) => migration.up(qr));
    await inSchema(schema, (qr) => migration.up(qr));

    expect(await columns(schema)).toEqual([
      {
        table_name: 'deployment_logs',
        column_name: 'deployed_by_email',
        is_nullable: 'YES',
        type: 'character varying(255)',
      },
      {
        table_name: 'feeding_parameters',
        column_name: 'createdByEmail',
        is_nullable: 'YES',
        type: 'character varying(255)',
      },
    ]);
    expect(await admin!.query(`SELECT deployed_by_email FROM "${schema}".deployment_logs`)).toEqual(
      [{ deployed_by_email: null }],
    );
    expect(
      await admin!.query(`SELECT "createdByEmail" FROM "${schema}".feeding_parameters`),
    ).toEqual([{ createdByEmail: null }]);
  });

  it('adds only the column whose table a schema has, and skips a schema with neither', async () => {
    const migration = new AddCommandActorEmails1824000000000();
    await inSchema('feeding_only', (qr) => migration.up(qr));
    await expect(inSchema('empty_schema', (qr) => migration.up(qr))).resolves.toBeUndefined();

    expect(await columns('feeding_only')).toEqual([
      expect.objectContaining({ table_name: 'feeding_parameters', column_name: 'createdByEmail' }),
    ]);
  });

  it('removes both columns on down', async () => {
    await inSchema(schema, (qr) => new AddCommandActorEmails1824000000000().down(qr));
    await inSchema('empty_schema', (qr) => new AddCommandActorEmails1824000000000().down(qr));
    expect(await columns(schema)).toEqual([]);
  });
});
