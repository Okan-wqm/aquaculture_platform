import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource, QueryRunner } from 'typeorm';

import { AddUserCredentialVersion1808500000000 } from '../1808500000000-AddUserCredentialVersion';

interface VersionRow {
  credentialVersion: number;
}

jest.setTimeout(120_000);

/**
 * ORPHAN-CRITICAL-808 — the contract the issuance fence relies on, proven on a
 * real Postgres: the database alone advances `credentialVersion`, it moves on
 * exactly the authorization-bearing columns, and login bookkeeping leaves it
 * where authentication read it.
 */
describe('AddUserCredentialVersion1808500000000 on real Postgres', () => {
  let harness: HarnessContext | undefined;
  const userId = '8025339a-e6c7-46df-b65a-dcf4f010b861';

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await requireAdmin().query('CREATE SCHEMA auth');
    // The columns the trigger reads plus the bookkeeping columns the login
    // path writes before minting.
    await requireAdmin().query(`
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        email varchar(255) NOT NULL,
        password varchar(255),
        role varchar(50) NOT NULL,
        "tenantId" uuid,
        "isActive" boolean NOT NULL DEFAULT true,
        "lastLoginAt" timestamptz,
        "lastLoginIp" varchar(50),
        "failedLoginAttempts" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await withQueryRunner(async (queryRunner) => {
      const migration = new AddUserCredentialVersion1808500000000();
      await migration.up(queryRunner);
      // Re-runnable without error or a second trigger.
      await migration.up(queryRunner);
    });
    await requireAdmin().query(
      `INSERT INTO auth.users (id, email, password, role, "tenantId")
       VALUES ($1, 'fence@example.test', 'p1:$2b$hash-one', 'TENANT_ADMIN', '7f6b08ab-90e2-46d3-a260-cb985f1fd897')`,
      [userId],
    );
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  it('starts every row at version 1 and installs exactly one trigger', async () => {
    expect(await readVersion()).toBe(1);
    const triggers = await requireAdmin().query<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal`,
    );
    expect(triggers).toEqual([{ tgname: 'trg_users_bump_credential_version' }]);
  });

  it('leaves the version untouched on the login bookkeeping write that precedes minting', async () => {
    // Exactly the UPDATE TypeORM issues for `user.lastLoginAt = …; save(user)`,
    // including the CURRENT_TIMESTAMP that broke the previous timestamp fence.
    await requireAdmin().query(
      `UPDATE auth.users
          SET "lastLoginAt" = $2, "lastLoginIp" = '193.212.164.37',
              "failedLoginAttempts" = 0, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [userId, new Date()],
    );
    expect(await readVersion()).toBe(1);
  });

  it('advances the version once per credential-bearing change: password, role, tenant, deactivation', async () => {
    await requireAdmin().query(`UPDATE auth.users SET password = 'p1:$2b$hash-two' WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(2);

    await requireAdmin().query(`UPDATE auth.users SET role = 'MODULE_USER' WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(3);

    await requireAdmin().query(`UPDATE auth.users SET "tenantId" = NULL WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(4);

    await requireAdmin().query(`UPDATE auth.users SET "isActive" = false WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(5);

    // Writing the same value again is not a change.
    await requireAdmin().query(`UPDATE auth.users SET "isActive" = false WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(5);
  });

  it('is owned by the database: a value supplied by the application is discarded', async () => {
    await requireAdmin().query(`UPDATE auth.users SET "credentialVersion" = 99 WHERE id = $1`, [userId]);
    expect(await readVersion()).toBe(5);

    await requireAdmin().query(
      `UPDATE auth.users SET "credentialVersion" = 99, password = 'p1:$2b$hash-three' WHERE id = $1`,
      [userId],
    );
    expect(await readVersion()).toBe(6);
  });

  it('down restores the pre-migration catalog', async () => {
    await withQueryRunner((queryRunner) => new AddUserCredentialVersion1808500000000().down(queryRunner));
    const columns = await requireAdmin().query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'credentialVersion'`,
    );
    expect(columns).toEqual([]);
    const functions = await requireAdmin().query<{ proname: string }[]>(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND proname = 'users_bump_credential_version'`,
    );
    expect(functions).toEqual([]);
  });

  async function readVersion(): Promise<number> {
    const rows = await requireAdmin().query<VersionRow[]>(
      `SELECT "credentialVersion" FROM auth.users WHERE id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('fixture user is missing');
    }
    return row.credentialVersion;
  }

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
});
