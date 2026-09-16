import type { QueryRunner } from 'typeorm';

import { AddUserCredentialVersion1808500000000 } from '../1808500000000-AddUserCredentialVersion';

function makeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: jest.fn((sql: string): Promise<unknown> => {
      queries.push(sql.replace(/\s+/gu, ' ').trim());
      return Promise.resolve([]);
    }),
  } as never;
  return { runner, queries };
}

describe('AddUserCredentialVersion1808500000000', () => {
  it('adds the database-owned credentialVersion column and the BEFORE UPDATE trigger that advances it', async () => {
    const { runner, queries } = makeRunner();
    await new AddUserCredentialVersion1808500000000().up(runner);

    expect(queries).toHaveLength(4);
    const [column, fn, dropTrigger, createTrigger] = queries;
    // Re-runnable: the runner may replay a migration after a partial boot.
    expect(column).toContain(
      'ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "credentialVersion" integer NOT NULL DEFAULT 1',
    );
    expect(fn).toContain('CREATE OR REPLACE FUNCTION "auth".users_bump_credential_version()');
    // Exactly the authorization-bearing columns move the counter; bookkeeping
    // writes (lastLoginAt, failedLoginAttempts, …) must not.
    for (const credentialColumn of ['"password"', '"role"', '"tenantId"', '"isActive"']) {
      expect(fn).toContain(`NEW.${credentialColumn} IS DISTINCT FROM OLD.${credentialColumn}`);
    }
    expect(fn).not.toContain('lastLoginAt');
    expect(fn).not.toContain('failedLoginAttempts');
    expect(fn).toContain('NEW."credentialVersion" := OLD."credentialVersion" + 1');
    // The ELSE branch pins NEW to OLD so the application can never write it.
    expect(fn).toContain('ELSE NEW."credentialVersion" := OLD."credentialVersion";');
    expect(dropTrigger).toBe(
      'DROP TRIGGER IF EXISTS trg_users_bump_credential_version ON "auth"."users"',
    );
    expect(createTrigger).toContain('CREATE TRIGGER trg_users_bump_credential_version');
    expect(createTrigger).toContain('BEFORE UPDATE ON "auth"."users"');
    expect(createTrigger).toContain(
      'FOR EACH ROW EXECUTE FUNCTION "auth".users_bump_credential_version()',
    );
  });

  it('down removes the trigger, the function and the column in dependency order', async () => {
    const { runner, queries } = makeRunner();
    await new AddUserCredentialVersion1808500000000().down(runner);

    expect(queries).toEqual([
      'DROP TRIGGER IF EXISTS trg_users_bump_credential_version ON "auth"."users"',
      'DROP FUNCTION IF EXISTS "auth".users_bump_credential_version()',
      'ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "credentialVersion"',
    ]);
  });
});
