import type { QueryRunner } from 'typeorm';

import { stub, stubMember } from '@aquaculture/testing';
import { AddUserModuleAssignmentRole1819300000000 } from '../1819300000000-AddUserModuleAssignmentRole';

function makeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = stub<QueryRunner>({
    query: stubMember<QueryRunner['query']>((sql: string): Promise<unknown> => {
      queries.push(sql.replace(/\s+/gu, ' ').trim());
      return Promise.resolve([]);
    }),
  });
  return { runner, queries };
}

/**
 * RBAC-HIGH-027, release R1 (C3): a module grant gains a role. The column is added nullable and
 * stays nullable in R1 — old containers keep inserting rows without it until they are replaced,
 * and PKG-06 sets NOT NULL in R3 after re-running the backfill.
 */
describe('AddUserModuleAssignmentRole1819300000000', () => {
  it('adds a nullable role column and a CHECK that admits only the module roles', async () => {
    const { runner, queries } = makeRunner();
    await new AddUserModuleAssignmentRole1819300000000().up(runner);

    expect(queries).toHaveLength(3);
    const [lockTimeout, column, check] = queries;
    expect(lockTimeout).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(column).toBe(
      'ALTER TABLE "auth"."user_module_assignments" ADD COLUMN IF NOT EXISTS "role" character varying(32)',
    );
    expect(column).not.toMatch(/NOT NULL|DEFAULT/u);
    // Re-runnable: PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.
    expect(check).toContain(`WHERE conname = 'CHK_user_module_assignments_role'`);
    expect(check).toContain(`AND conrelid = 'auth.user_module_assignments'::regclass`);
    expect(check).toContain(
      `ADD CONSTRAINT "CHK_user_module_assignments_role" CHECK ("role" IN ('MODULE_MANAGER', 'MODULE_USER'))`,
    );
  });

  it('down removes the constraint, then the column', async () => {
    const { runner, queries } = makeRunner();
    await new AddUserModuleAssignmentRole1819300000000().down(runner);

    expect(queries).toEqual([
      'ALTER TABLE "auth"."user_module_assignments" DROP CONSTRAINT IF EXISTS "CHK_user_module_assignments_role"',
      'ALTER TABLE "auth"."user_module_assignments" DROP COLUMN IF EXISTS "role"',
    ]);
  });
});
