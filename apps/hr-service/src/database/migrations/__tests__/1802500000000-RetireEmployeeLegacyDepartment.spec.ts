/**
 * RetireEmployeeLegacyDepartment (1802500000000) — statement-level contract.
 * ============================================================================
 *
 * The migration runs against a recording QueryRunner, so what is checked here is WHICH statements
 * it issues, in which order, under which guards: the transaction-local RLS bypass, the single
 * UNPLACED predicate, the case-insensitive matching rule and its deterministic choice, the
 * attendance snapshot, and what `down` refuses to touch. The SQL itself is exercised on a real
 * PostgreSQL, as a non-superuser table owner under the FORCEd tenant policy, by
 * `libs/migration-harness/src/__tests__/hr-retire-employee-department.integration.spec.ts`
 * (that spec, not this one, is what proves the backfill moves the data correctly).
 *
 * `db-migration-check.yml` only migrates a fresh database that has no legacy employees: it proves the
 * chain applies and `postCondition` holds there, not that any employee is placed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { QueryRunner } from 'typeorm';

import { RetireEmployeeLegacyDepartment1802500000000 } from '../1802500000000-RetireEmployeeLegacyDepartment';

const BASELINE = readFileSync(join(__dirname, '../1800000000000-Baseline.ts'), 'utf8');

/** The one predicate revive, insert, link and the probe share. */
const UNPLACED_PREDICATE = `e."isDeleted" = false AND e."departmentHrId" IS NULL AND e."department" IS NOT NULL`;

interface Run {
  readonly statements: string[];
  readonly results: unknown[];
}

/** Runs one lifecycle method against a recording QueryRunner; every statement is whitespace-normalised. */
async function run(
  method: 'up' | 'down' | 'postCondition',
  options: { inTransaction?: boolean; probe?: unknown } = {},
): Promise<Run> {
  const statements: string[] = [];
  const query = jest.fn(async (statement: string): Promise<unknown> => {
    statements.push(statement.replace(/\s+/g, ' ').trim());
    return /\bAS ok\b/.test(statement) ? options.probe : [];
  });
  const queryRunner = {
    query,
    isTransactionActive: options.inTransaction ?? true,
  } as Pick<QueryRunner, 'query' | 'isTransactionActive'> as QueryRunner;
  const migration = new RetireEmployeeLegacyDepartment1802500000000();
  const results = [await migration[method](queryRunner)];
  return { statements, results };
}

const indexOfStatement = (statements: readonly string[], pattern: RegExp): number =>
  statements.findIndex((statement) => pattern.test(statement));

/** Statements that write data (a CTE-led statement still ends in the INSERT / UPDATE / DELETE). */
const dmlIndexes = (statements: readonly string[]): number[] =>
  statements.flatMap((statement, index) =>
    /\b(INSERT INTO|UPDATE|DELETE FROM) "/.test(statement) ? [index] : [],
  );

const BYPASS_ON = /set_config\('app\.bypass_rls', 'on', true\)/;
const BYPASS_OFF = /set_config\('app\.bypass_rls', 'off', true\)/;

/** The statement of `up` that matches `pattern`; fails loudly when there is not exactly one. */
async function upStatement(pattern: RegExp): Promise<string> {
  const matches = (await run('up')).statements.filter((statement) => pattern.test(statement));
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
}

const reviveStatement = (): Promise<string> =>
  upStatement(/^WITH "legacy" AS .* UPDATE "departments_hr" d SET "isDeleted" = false/);
const insertStatement = (): Promise<string> => upStatement(/^INSERT INTO "departments_hr"/);
const linkStatement = (): Promise<string> =>
  upStatement(/UPDATE "employees" e SET "departmentHrId" = c\."id"/);

/** Which of several matching departments is THE one: exact upper-case code, then oldest, then lowest id. */
const PREFERRED_FIRST = '(d."code" = upper(d."code")) DESC, d."createdAt" ASC, d."id" ASC';

describe('RetireEmployeeLegacyDepartment1802500000000 up', () => {
  it('refuses to run outside the runner transaction (the bypass is transaction-local)', async () => {
    await expect(run('up', { inTransaction: false })).rejects.toThrow(
      /inside the runner's transaction/,
    );
  });

  it('drops NOT NULL first, writes the data only under the RLS bypass, then drops the index', async () => {
    const { statements } = await run('up');
    const dropNotNull = indexOfStatement(
      statements,
      /^DO \$\$ BEGIN IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE .* is_nullable = 'NO'\) THEN ALTER TABLE "employees" ALTER COLUMN "department" DROP NOT NULL; END IF; END \$\$$/,
    );
    const bypassOn = indexOfStatement(statements, BYPASS_ON);
    const bypassOff = indexOfStatement(statements, BYPASS_OFF);
    const dropIndex = indexOfStatement(statements, /^DROP INDEX IF EXISTS "/);
    const writes = dmlIndexes(statements);

    expect(dropNotNull).toBeGreaterThanOrEqual(0);
    // revive, insert, and the link-with-attendance statement
    expect(writes).toHaveLength(3);
    // The ACCESS EXCLUSIVE lock of the DDL is taken before the backfill reads, so no unplaced row can slip in.
    expect(dropNotNull).toBeLessThan(bypassOn);
    expect(bypassOn).toBeLessThan(Math.min(...writes));
    expect(Math.max(...writes)).toBeLessThan(bypassOff);
    expect(bypassOff).toBeLessThan(dropIndex);
  });

  it('drops exactly the (tenantId, department) index the Baseline built', async () => {
    const baselineIndex =
      /CREATE INDEX "(IDX_[0-9a-f]+)" ON "employees" \("tenantId", "department"\)/.exec(
        BASELINE,
      )?.[1];
    expect(baselineIndex).toBeDefined();
    const { statements } = await run('up');
    expect(statements).toContain(`DROP INDEX IF EXISTS "${baselineIndex}"`);
  });

  it('never writes the retired column', async () => {
    const { statements } = await run('up');
    expect(
      statements.filter((statement) => /\bSET\b[^;]*"department"\s*=/.test(statement)),
    ).toEqual([]);
  });

  describe('which employees it is about', () => {
    it('revive, insert and link all read the one UNPLACED predicate, and so does the probe', async () => {
      for (const statement of [
        await reviveStatement(),
        await insertStatement(),
        await linkStatement(),
      ]) {
        expect(statement).toContain(UNPLACED_PREDICATE);
      }
      const probe = (await run('postCondition', { probe: [{ ok: true }] })).statements.find(
        (statement) => /\bAS ok\b/.test(statement),
      );
      expect(probe).toContain(UNPLACED_PREDICATE);
    });

    it('revive and insert start from the same set of (tenant, legacy value) pairs', async () => {
      const pairs = `SELECT DISTINCT e."tenantId", e."department"::text AS "legacyValue" FROM "employees" e WHERE ${UNPLACED_PREDICATE}`;
      expect(await reviveStatement()).toContain(pairs);
      expect(await insertStatement()).toContain(pairs);
    });
  });

  describe('matching a department to a legacy value (letter case never matters)', () => {
    it('revive, insert and link compare upper(code) with upper(value) and never the code as spelled', async () => {
      const revive = await reviveStatement();
      const insert = await insertStatement();
      const link = await linkStatement();

      expect(revive).toContain('upper(d."code") = upper(legacy."legacyValue")');
      expect(revive).toContain('upper(live."code") = upper(legacy."legacyValue")');
      expect(insert).toContain('upper(d."code") = upper(legacy."legacyValue")');
      expect(link).toContain('upper(c."legacyCode") = upper(e."department"::text)');
      // The exact-code comparison this migration used to make would not recognise 'Management'.
      for (const statement of [revive, insert, link]) {
        expect(statement).not.toMatch(/d\."code" = upper\(e\./);
        expect(statement).not.toMatch(/d\."code" = upper\(legacy\./);
      }
    });

    it('revives only when NO live department matches, and one department per legacy value', async () => {
      const revive = await reviveStatement();
      expect(revive).toContain('WHERE d."isDeleted" = true AND NOT EXISTS');
      expect(revive).toMatch(
        /NOT EXISTS \( SELECT 1 FROM "departments_hr" live WHERE live\."tenantId" = legacy\."tenantId" AND live\."isDeleted" = false/,
      );
      expect(revive).toContain(
        'SELECT DISTINCT ON (legacy."tenantId", legacy."legacyValue") d."id"',
      );
      expect(revive).toContain(
        `ORDER BY legacy."tenantId", legacy."legacyValue", ${PREFERRED_FIRST} )`,
      );
    });

    it('inserts only when NO row, live or soft-deleted, matches', async () => {
      const insert = await insertStatement();
      const notExists =
        /WHERE NOT EXISTS \( (SELECT 1 FROM "departments_hr" d WHERE .*?) \) ON CONFLICT/.exec(
          insert,
        )?.[1];
      expect(notExists).toBeDefined();
      // No isDeleted condition: a soft-deleted row still owns the (tenantId, code) slot.
      expect(notExists).not.toContain('isDeleted');
      expect(insert).toContain('ON CONFLICT DO NOTHING');
    });

    it('links to ONE live department per (tenant, code): exact upper-case code, then oldest, then lowest id', async () => {
      const link = await linkStatement();
      expect(link).toContain(
        'SELECT DISTINCT ON (d."tenantId", upper(d."code")) d."tenantId", upper(d."code") AS "legacyCode", d."id" FROM "departments_hr" d WHERE d."isDeleted" = false',
      );
      // The ORDER BY leads with the DISTINCT ON columns and ends in a total order (id is unique).
      expect(link).toContain(`ORDER BY d."tenantId", upper(d."code"), ${PREFERRED_FIRST} )`);
    });

    it('revive and link choose by the same order, so the department revived is the one linked', async () => {
      // One total order spelled once in the migration: both statements must carry it verbatim.
      expect(await reviveStatement()).toContain(PREFERRED_FIRST);
      expect(await linkStatement()).toContain(PREFERRED_FIRST);
    });

    it('creates a missing department company-wide with the columns the Baseline demands', async () => {
      const insert = await insertStatement();
      const columns = [
        ...(/^INSERT INTO "departments_hr" \(([^)]*)\)/.exec(insert)?.[1] ?? '').matchAll(
          /"([A-Za-z]+)"/g,
        ),
      ].map((match) => match[1]);

      // moduleCode stays NULL: nothing in the legacy data says which module an enum value served.
      expect(columns).not.toContain('moduleCode');
      // NOT NULL without a default in the Baseline: everything else (id, flags, timestamps) has one.
      // The real-Postgres spec inserts through this statement into the real table.
      expect(columns).toEqual(['tenantId', 'name', 'code', 'description', 'version']);
    });

    it('guards the soft-deleted-code case: the unique (tenantId, code) index spans soft-deleted rows', async () => {
      expect(BASELINE).toMatch(
        /CREATE UNIQUE INDEX "IDX_\w+" ON "departments_hr" \("tenantId", "code"\)/,
      );
      expect(await reviveStatement()).toContain('SET "isDeleted" = false');
    });
  });

  describe('placement and the attendance snapshot', () => {
    it('places only employees still without a department, so a replay is a no-op', async () => {
      const link = await linkStatement();
      const placement = /"placed" AS \( (UPDATE "employees" e .*?) RETURNING/.exec(link)?.[1];
      expect(placement).toBeDefined();
      expect(placement).toContain(UNPLACED_PREDICATE);
      expect(link).toMatch(/RETURNING e\."id", e\."tenantId", e\."departmentHrId"/);
    });

    it('snapshots the placement onto the NULL attendance records of the employees placed by THIS statement', async () => {
      const link = await linkStatement();
      const snapshot = /\) UPDATE "attendance_records" a (.*)$/.exec(link)?.[1];
      expect(snapshot).toBeDefined();
      // Taken from what the placement returned, never from "every employee that has a department".
      expect(snapshot).toContain('SET "departmentId" = p."departmentHrId"::text FROM "placed" p');
      expect(snapshot).toContain('a."tenantId" = p."tenantId" AND a."employeeId" = p."id"');
      // A snapshot a clock-in wrote is never rewritten.
      expect(snapshot).toMatch(/AND a\."departmentId" IS NULL$/);
    });

    it('touches attendance nowhere else in up', async () => {
      const { statements } = await run('up');
      expect(statements.filter((statement) => /"attendance_records"/.test(statement))).toHaveLength(
        1,
      );
    });

    it('writes the snapshot before the bypass is switched off', async () => {
      const { statements } = await run('up');
      const snapshot = indexOfStatement(statements, /UPDATE "attendance_records" a/);
      const bypassOff = indexOfStatement(statements, BYPASS_OFF);
      expect(snapshot).toBeGreaterThanOrEqual(0);
      expect(snapshot).toBeLessThan(bypassOff);
    });
  });
});

describe('RetireEmployeeLegacyDepartment1802500000000 postCondition', () => {
  it('passes only when the probe says ok, and brackets the probe with the RLS bypass', async () => {
    const passing = await run('postCondition', { probe: [{ ok: true }] });
    expect(passing.results).toEqual([true]);
    const bypassOn = indexOfStatement(passing.statements, BYPASS_ON);
    const probe = indexOfStatement(passing.statements, /\bAS ok\b/);
    const bypassOff = indexOfStatement(passing.statements, BYPASS_OFF);
    expect(bypassOn).toBeLessThan(probe);
    expect(probe).toBeLessThan(bypassOff);
  });

  it.each([[[{ ok: false }]], [[{ ok: null }]], [[]]])(
    'fails closed on probe result %j',
    async (probe) => {
      const { results } = await run('postCondition', { probe });
      expect(results).toEqual([false]);
    },
  );

  it('probes the three outcomes: nullable column, index gone, no live employee left unplaced', async () => {
    const { statements } = await run('postCondition', { probe: [{ ok: true }] });
    const probe = statements.find((statement) => /\bAS ok\b/.test(statement)) ?? '';
    expect(probe).toMatch(/column_name = 'department'/);
    expect(probe).toMatch(/is_nullable = 'YES'/);
    expect(probe).toMatch(/NOT EXISTS \( SELECT 1 FROM pg_indexes/);
    expect(probe).toMatch(/NOT EXISTS \( SELECT 1 FROM "employees" e WHERE e\."isDeleted" = false/);
  });
});

describe('RetireEmployeeLegacyDepartment1802500000000 down', () => {
  it('refuses to run outside the runner transaction', async () => {
    await expect(run('down', { inTransaction: false })).rejects.toThrow(
      /inside the runner's transaction/,
    );
  });

  it('refills every NULL department before re-imposing NOT NULL, then restores the index', async () => {
    const { statements } = await run('down');
    const refill = indexOfStatement(
      statements,
      /^UPDATE "employees" SET "department" = '\w+' WHERE "department" IS NULL$/,
    );
    const setNotNull = indexOfStatement(
      statements,
      /^DO \$\$ BEGIN IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE .* is_nullable = 'YES'\) THEN ALTER TABLE "employees" ALTER COLUMN "department" SET NOT NULL; END IF; END \$\$$/,
    );
    const recreate = indexOfStatement(
      statements,
      /^CREATE INDEX IF NOT EXISTS "IDX_[0-9a-f]+" ON "employees" \("tenantId", "department"\)$/,
    );
    expect(refill).toBeGreaterThanOrEqual(0);
    expect(refill).toBeLessThan(setNotNull);
    expect(setNotNull).toBeGreaterThanOrEqual(0);
    expect(recreate).toBeGreaterThan(setNotNull);
    // The index it re-creates is the one `up` drops.
    const dropped = /^DROP INDEX IF EXISTS "(IDX_[0-9a-f]+)"$/;
    const upIndex = (await run('up')).statements
      .map((statement) => dropped.exec(statement)?.[1])
      .find((name) => name !== undefined);
    expect(statements[recreate]).toContain(`"${upIndex}"`);
  });

  it('deletes only the departments `up` inserted, by the marker `up` wrote, and only when unreferenced', async () => {
    const marker = /'(Backfilled by migration \d+): '/.exec(await insertStatement())?.[1];
    expect(marker).toBeDefined();

    const { statements } = await run('down');
    const deletion =
      statements.find((statement) => /^DELETE FROM "departments_hr"/.test(statement)) ?? '';
    expect(deletion).toContain(`LIKE '${marker}:%'`);
    // A department the attendance snapshot now points at is among the referrers that keep it alive.
    for (const referrer of [
      '"employees"',
      '"departments_hr" child',
      '"schedules"',
      '"attendance_records"',
    ]) {
      expect(deletion).toContain(`NOT EXISTS (SELECT 1 FROM ${referrer}`);
    }
  });

  it('leaves attendance untouched: the snapshot `up` wrote cannot be told from a clock-in snapshot', async () => {
    const { statements } = await run('down');
    expect(
      statements.filter((statement) =>
        /^(WITH .* )?(UPDATE|DELETE FROM|INSERT INTO) "attendance_records"/.test(statement),
      ),
    ).toEqual([]);
  });
});
