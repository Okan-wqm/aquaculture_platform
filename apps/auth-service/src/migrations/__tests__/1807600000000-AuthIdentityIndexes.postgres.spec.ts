import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource, QueryRunner } from 'typeorm';

import { EnforceUserSiteAssignmentTenantIdentity1807600000000 } from '../1807600000000-EnforceUserSiteAssignmentTenantIdentity';
import { AddSystemOutboxIdempotency1807700000000 } from '../1807700000000-AddSystemOutboxIdempotency';

interface ConstraintRow {
  name: string;
  type: string;
  validated: boolean;
  definition: string;
}

interface IndexRow {
  name: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  predicate: string | null;
  columns: string[];
}

jest.setTimeout(120_000);

describe('auth identity migrations on real Postgres', () => {
  let harness: HarnessContext | undefined;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await requireAdmin().query('CREATE SCHEMA auth');
    await requireAdmin().query(`
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL
      )
    `);
    await requireAdmin().query(`
      CREATE TABLE auth.user_site_assignments (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        CONSTRAINT "FK_user_site_assignments_user"
          FOREIGN KEY ("userId") REFERENCES auth.users (id) ON DELETE CASCADE
      )
    `);
    await requireAdmin().query(`
      CREATE TABLE auth.auth_outbox (
        id uuid PRIMARY KEY,
        "tenantId" uuid NULL,
        "idempotencyKey" varchar(255) NULL
      )
    `);
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  it('replays the user/site identity cutover into one exact validated contract', async () => {
    const migration = new EnforceUserSiteAssignmentTenantIdentity1807600000000();
    expect(migration.transaction).toBe(false);

    await withQueryRunner(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.up(queryRunner);
    });

    const constraints = await requireAdmin().query<ConstraintRow[]>(`
      SELECT
        constraint_state.conname AS name,
        constraint_state.contype AS type,
        constraint_state.convalidated AS validated,
        pg_get_constraintdef(constraint_state.oid) AS definition
      FROM pg_constraint constraint_state
      WHERE constraint_state.conrelid IN (
        'auth.users'::regclass,
        'auth.user_site_assignments'::regclass
      )
        AND constraint_state.conname IN (
          'UQ_users_id_tenant',
          'FK_user_site_assignments_user_tenant',
          'FK_user_site_assignments_user'
        )
      ORDER BY constraint_state.conname
    `);
    expect(constraints).toHaveLength(2);
    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'UQ_users_id_tenant',
          type: 'u',
          validated: true,
        }),
        expect.objectContaining({
          name: 'FK_user_site_assignments_user_tenant',
          type: 'f',
          validated: true,
        }),
      ]),
    );
    const foreignKey = constraints.find(
      (constraint) => constraint.name === 'FK_user_site_assignments_user_tenant',
    );
    expect(foreignKey?.definition).toContain(
      'FOREIGN KEY ("userId", "tenantId") REFERENCES users(id, "tenantId") ON DELETE CASCADE',
    );

    const lookup = await readIndex('IDX_user_site_assignments_user_tenant');
    expect(lookup).toMatchObject({
      unique: false,
      valid: true,
      ready: true,
      predicate: null,
      columns: ['userId', 'tenantId'],
    });
  });

  it('rejects duplicate platform outbox keys, then replays one exact partial unique index', async () => {
    await requireAdmin().query(`
      INSERT INTO auth.auth_outbox (id, "tenantId", "idempotencyKey") VALUES
        ('00000000-0000-4000-8000-000000000001', NULL, 'system-event'),
        ('00000000-0000-4000-8000-000000000002', NULL, 'system-event')
    `);
    const migration = new AddSystemOutboxIdempotency1807700000000();
    expect(migration.transaction).toBe(false);

    await expect(withQueryRunner((queryRunner) => migration.up(queryRunner))).rejects.toThrow(
      'duplicate keys exist',
    );
    expect(await readIndex('idx_auth_outbox_system_idempotency')).toBeNull();

    await requireAdmin().query(`
      DELETE FROM auth.auth_outbox
      WHERE id = '00000000-0000-4000-8000-000000000002'
    `);
    await withQueryRunner(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.up(queryRunner);
    });

    const index = await readIndex('idx_auth_outbox_system_idempotency');
    expect(index).toMatchObject({
      unique: true,
      valid: true,
      ready: true,
      columns: ['idempotencyKey'],
    });
    expect(index?.predicate?.replace(/[\s()"]+/gu, '')).toBe(
      'tenantIdISNULLANDidempotencyKeyISNOTNULL',
    );
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  async function withQueryRunner(
    operation: (queryRunner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const queryRunner = requireAdmin().createQueryRunner();
    await queryRunner.connect();
    try {
      await operation(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  async function readIndex(name: string): Promise<IndexRow | null> {
    const rows = await requireAdmin().query<IndexRow[]>(
      `
        SELECT
          index_class.relname AS name,
          index_state.indisunique AS "unique",
          index_state.indisvalid AS "valid",
          index_state.indisready AS "ready",
          pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate,
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(index_state.indkey)
              WITH ORDINALITY AS keys(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = table_class.oid
             AND attribute.attnum = keys.attnum
            WHERE keys.ordinality <= index_state.indnkeyatts
            ORDER BY keys.ordinality
          ) AS columns
        FROM pg_class index_class
        JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
        JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
        JOIN pg_class table_class ON table_class.oid = index_state.indrelid
        WHERE index_namespace.nspname = 'auth'
          AND index_class.relname = $1
      `,
      [name],
    );
    return rows[0] ?? null;
  }
});
