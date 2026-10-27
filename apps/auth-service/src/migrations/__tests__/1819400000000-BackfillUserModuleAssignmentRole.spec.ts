import { Logger } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

import { stub, stubMember } from '@aquaculture/testing';
import { BackfillUserModuleAssignmentRole1819400000000 } from '../1819400000000-BackfillUserModuleAssignmentRole';

interface Answers {
  readonly inserted: number;
  readonly managers: number;
  readonly users: number;
  readonly remaining: number;
  readonly hrDesignatedWithoutGrant: number;
}

const DEFAULT_ANSWERS: Answers = {
  inserted: 2,
  managers: 5,
  users: 11,
  remaining: 0,
  hrDesignatedWithoutGrant: 1,
};

function makeRunner(answers: Answers = DEFAULT_ANSWERS): {
  runner: QueryRunner;
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const runner = stub<QueryRunner>({
    query: stubMember<QueryRunner['query']>((sql: string, params?: unknown[]): Promise<unknown> => {
      const compact = sql.replace(/\s+/gu, ' ').trim();
      queries.push({ sql: compact, params });
      if (compact.includes('AS "inserted"'))
        return Promise.resolve([{ inserted: answers.inserted }]);
      if (compact.includes('AS "managers"')) {
        return Promise.resolve([{ managers: answers.managers, users: answers.users }]);
      }
      if (compact.includes('AS "remaining"'))
        return Promise.resolve([{ remaining: answers.remaining }]);
      if (compact.includes('AS "hrDesignatedWithoutGrant"')) {
        return Promise.resolve([{ hrDesignatedWithoutGrant: answers.hrDesignatedWithoutGrant }]);
      }
      return Promise.resolve([]);
    }),
  });
  return { runner, queries };
}

/**
 * RBAC-HIGH-027, release R1: every existing module grant gets a role, by the rule ADR-051 §2
 * fixes. MODULE_MANAGER comes from isPrimaryManager, from a tenant_modules.managerId (whose
 * missing row is inserted), or from the legacy global MODULE_MANAGER for modules other than hr;
 * an hr manager grant comes only from isPrimaryManager (D6); everyone else is MODULE_USER. The
 * real-Postgres behaviour is pinned by the .postgres.spec beside this one.
 */
describe('BackfillUserModuleAssignmentRole1819400000000', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bounds its waits, lifts the forced RLS, then inserts the designated managers, sets the roles and checks none is left', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { runner, queries } = makeRunner();

    await new BackfillUserModuleAssignmentRole1819400000000().up(runner);

    expect(queries.map((query) => query.sql.slice(0, 40))).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `SET LOCAL statement_timeout = '60s'`,
      // The runner binds no tenant: without the transaction-local bypass the forced
      // tenant-isolation policy on both auth tables would hide every row.
      `SELECT pg_catalog.set_config('app.bypass`,
      'WITH inserted AS ( INSERT INTO "auth"."u',
      'WITH updated AS ( UPDATE "auth"."user_mo',
      'SELECT count(*)::int AS "remaining" FROM',
      'SELECT count(*)::int AS "hrDesignatedWit',
    ]);
    // Transaction-local (third argument true): the bypass ends with the migration's transaction.
    expect(queries[2]?.sql).toBe(`SELECT pg_catalog.set_config('app.bypass_rls', 'on', true)`);
  });

  it('inserts a MODULE_MANAGER row for each same-tenant managerId of farm, sensor or hydroponics, never hr', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { runner, queries } = makeRunner();

    await new BackfillUserModuleAssignmentRole1819400000000().up(runner);

    const insert = queries[3];
    expect(insert?.sql).toContain(
      'SELECT tm."managerId", tm."moduleId", tm."tenantId", false, true, tm."managerId", $1, \'MODULE_MANAGER\'',
    );
    expect(insert?.sql).toContain(
      'JOIN "auth"."users" u ON u."id" = tm."managerId" AND u."tenantId" = tm."tenantId"',
    );
    expect(insert?.sql).toContain(`AND m."code" IN ('farm', 'sensor', 'hydroponics')`);
    expect(insert?.sql).toContain('ON CONFLICT ("userId", "moduleId") DO NOTHING');
    expect(insert?.params).toEqual([
      'Inserted from tenant_modules.managerId by BackfillUserModuleAssignmentRole1819400000000',
    ]);
  });

  it('sets only rows without a role, by the ADR-051 rule', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { runner, queries } = makeRunner();

    await new BackfillUserModuleAssignmentRole1819400000000().up(runner);

    const update = queries[4]?.sql ?? '';
    expect(update).toContain(`WHEN uma."isPrimaryManager" THEN 'MODULE_MANAGER'`);
    expect(update).toContain(
      `WHEN m."code" <> 'hr' AND (u."role" = 'MODULE_MANAGER' OR EXISTS ( SELECT 1 FROM "auth"."tenant_modules" tm WHERE tm."tenantId" = uma."tenantId" AND tm."moduleId" = uma."moduleId" AND tm."managerId" = uma."userId")) THEN 'MODULE_MANAGER'`,
    );
    expect(update).toContain(`ELSE 'MODULE_USER' END`);
    expect(update).toContain('AND uma."role" IS NULL');
    // The primary-manager branch is tested first, so an hr primary manager still manages hr.
    expect(update.indexOf('isPrimaryManager')).toBeLessThan(update.indexOf(`<> 'hr'`));
  });

  it('logs the counts', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { runner } = makeRunner();

    await new BackfillUserModuleAssignmentRole1819400000000().up(runner);

    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0] ?? [];
    expect(JSON.parse(String(message))).toEqual({
      event: 'user_module_assignment_role_backfill',
      managerIdRowsInserted: 2,
      managers: 5,
      users: 11,
      hrDesignatedWithoutGrant: 1,
    });
  });

  it('fails the migration when a row is still without a role (post-condition)', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { runner } = makeRunner({ ...DEFAULT_ANSWERS, remaining: 3 });

    await expect(new BackfillUserModuleAssignmentRole1819400000000().up(runner)).rejects.toThrow(
      '3 user_module_assignments row(s) have no role after the backfill',
    );
  });

  it('down is forward-only: the roles are what the live writers write', async () => {
    const { runner, queries } = makeRunner();

    await new BackfillUserModuleAssignmentRole1819400000000().down(runner);

    expect(queries).toEqual([]);
  });
});
