/**
 * Code sequence schema alignment migration tests.
 *
 * WHY 2026-04-29: production DDL drifted from the CodeSequence entity
 * (`tenant_id`/`last_sequence`) while runtime generation writes camelCase
 * columns atomically. This proves the migration repairs both source and
 * existing tenant schemas instead of relying on handler-level workarounds.
 */
import 'reflect-metadata';

import { getTenantSchemaName } from '@aquaculture/backend-common';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';

import { AlignCodeSequencesSchema1786900000000 } from '../../database/migrations/.archive/2026-05-18T09-42-08-277Z/1786900000000-AlignCodeSequencesSchema';

const TENANT_ID = '4b529829-ea79-48da-982c-cd6fbec8ffb7';

jest.setTimeout(120_000);

describe('AlignCodeSequencesSchema1786900000000', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');
    await pg.dataSource.query(`CREATE SCHEMA "${getTenantSchemaName(TENANT_ID)}"`);

    await createLegacyCodeSequencesTable('farm');
    await createLegacyCodeSequencesTable(getTenantSchemaName(TENANT_ID));
    await pg.dataSource.query(
      `
      INSERT INTO "${getTenantSchemaName(TENANT_ID)}"."code_sequences"
        ("tenant_id", "entity_type", "prefix", "year", "last_sequence")
      VALUES ($1, 'Tank', 'TNK', $2, 41)
      `,
      [TENANT_ID, new Date().getFullYear()],
    );
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  it('converges legacy source and tenant tables to the canonical camelCase entity shape', async () => {
    const migration = new AlignCodeSequencesSchema1786900000000();
    const queryRunner = pg!.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    await expectColumns('farm');
    await expectColumns(getTenantSchemaName(TENANT_ID));

    const rows: Array<{ next_sequence: number }> = await pg!.dataSource.query(
      `
      INSERT INTO "${getTenantSchemaName(TENANT_ID)}"."code_sequences"
        ("tenantId", "entityType", "prefix", "year", "lastSequence", "lastGeneratedAt")
      VALUES ($1, 'Tank', 'TNK', $2, 1, now())
      ON CONFLICT ("tenantId", "entityType", "year")
      DO UPDATE SET
        "lastSequence" = "code_sequences"."lastSequence" + 1,
        "lastGeneratedAt" = now()
      RETURNING "lastSequence" AS next_sequence
      `,
      [TENANT_ID, new Date().getFullYear()],
    );

    expect(rows[0]?.next_sequence).toBe(42);
  });

  async function createLegacyCodeSequencesTable(schema: string): Promise<void> {
    await pg!.dataSource.query(`
      CREATE TABLE "${schema}"."code_sequences" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "entity_type" varchar(50) NOT NULL,
        "prefix" varchar(10) NOT NULL,
        "year" integer NOT NULL,
        "last_sequence" integer NOT NULL DEFAULT 0,
        "last_generated_at" timestamp NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
  }

  async function expectColumns(schema: string): Promise<void> {
    const rows: Array<{ column_name: string }> = await pg!.dataSource.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'code_sequences'
      `,
      [schema],
    );
    const columns = new Set(rows.map((row) => row.column_name));
    expect(columns.has('tenantId')).toBe(true);
    expect(columns.has('entityType')).toBe(true);
    expect(columns.has('lastSequence')).toBe(true);
    expect(columns.has('lastGeneratedAt')).toBe(true);
    expect(columns.has('tenant_id')).toBe(false);
    expect(columns.has('entity_type')).toBe(false);
    expect(columns.has('last_sequence')).toBe(false);
  }
});
