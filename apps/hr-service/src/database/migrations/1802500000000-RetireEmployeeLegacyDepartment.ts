import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireEmployeeLegacyDepartment — an employee's department becomes
 * `employees."departmentHrId"` and nothing else.
 *
 * Until now an employee carried TWO department mechanisms: the fixed
 * `department` enum (operations, maintenance, feeding, ...) and the
 * `departmentHrId` link into `departments_hr`. The enum cannot say which
 * module a person belongs to, so it is retired from the entity and the API;
 * `departments_hr` (with its `moduleCode`) is the one SSoT. This migration
 * moves the data across and makes the retired column harmless:
 *
 *   1. `ALTER COLUMN department DROP NOT NULL` — the new release no longer
 *      writes the column, so an INSERT that omits it must not be rejected
 *      (the Baseline declared it NOT NULL with no default). Done FIRST so its
 *      ACCESS EXCLUSIVE lock is held to COMMIT: no old container can commit a
 *      still-unplaced employee between the backfill and the commit, which
 *      keeps the backfill exact and the `postCondition` deterministic.
 *   2. For every distinct (tenantId, department) among live employees with no
 *      `departmentHrId`, ensure a `departments_hr` row with
 *      code = upper(department) (company-wide: `moduleCode` NULL — nothing in
 *      the data says which module an enum value served). A department is
 *      recognised by its code compared CASE-INSENSITIVELY (`upper(code) =
 *      upper(department)`): the unique index (tenantId, code) is case-sensitive,
 *      so a tenant may already hold 'Management' or 'operations' for what the
 *      enum calls management / operations, and inserting beside it would leave
 *      two departments with the same name. Then:
 *        - a LIVE row that matches is REUSED, never duplicated;
 *        - when NO live row matches, a SOFT-DELETED one is revived. The unique
 *          index spans soft-deleted rows, so inserting would violate it and abort
 *          the migration for the tenant, and the employees demonstrably still
 *          belong to that department;
 *        - when NO row at all matches (live or soft-deleted), one is INSERTED,
 *          marked in `description` so `down` can remove exactly those rows.
 *      Several rows can match the same (tenantId, department) (old data may hold
 *      'OPS' and 'ops'). ONE is chosen, by the same order in the revive and the
 *      link, so a replay or a different row order can never pick another: a row
 *      whose code is exactly upper(department) first, then the earliest
 *      `createdAt`, then the lowest `id`. The others are left as they are.
 *   3. `departmentHrId` is set on every such employee to the chosen department
 *      (only where it is NULL, so a replay changes nothing).
 *   4. `attendance_records."departmentId"` is a per-record snapshot of the
 *      employee's `departmentHrId` taken at clock-in / manual entry. The
 *      employees step 3 just placed had no department, so every record they
 *      already own carries NULL and drops out of every department-filtered view
 *      (pending approvals filter by it). Those records get the new placement,
 *      and ONLY those: employees placed by an admin or an earlier run are not
 *      touched, and a record whose snapshot is already set is never rewritten.
 *      Steps 3 and 4 are ONE statement (the update of step 3 feeds step 4
 *      through RETURNING), because "employees placed by this run" cannot be
 *      recognised once the statement has finished.
 *   5. The (tenantId, department) index, `IDX_c0e4b9f3e9e82b05072fce2069` from
 *      the Baseline, is dropped: no code reads by it any more, and a retired
 *      column should not keep costing write amplification.
 *
 * # RLS
 *
 * The runner binds no tenant and the tenant-isolation policy is FORCEd, so
 * without the bypass the backfill would see zero rows (and the INSERT would
 * be refused). The data statements and the probe run under
 * `app.bypass_rls` set transaction-locally, as
 * `alert-engine/1801300000000-BackfillAlertHistorySiteAndModule` and
 * `sensor-service/1822000000000-BackfillEdgeDeviceDirectory` do; it is
 * switched off again before the DDL and cannot outlive the transaction.
 *
 * # Blue-green
 *
 * Nullable column drop-not-null is metadata-only (no rewrite). WRITES work in both
 * directions: old containers keep inserting a `department` value, new ones omit it.
 * READS do not: the previous release declares `Employee.department` non-null in GraphQL,
 * so an employee row the NEW release created (department NULL) makes the old release's
 * employee queries fail while both run. The overlap is short and a release that applied
 * a migration is rolled forward, never back (the deploy refuses an image rollback), so
 * this is accepted rather than worked around by keeping the retired column written. The
 * columns `department` and `isFarmWorker` stay as orphans (drift class E =
 * warn) and are dropped in a later release with `dropOrphanedColumns` (HR-MEDIUM-052), because
 * old containers still read them during the rollout. Employees an old
 * container creates AFTER this migration commits carry `department` but no
 * `departmentHrId`; the orphan column keeps that value so the same backfill
 * (placement and attendance snapshot) can be re-run before the drop release —
 * do not drop `department` without it.
 *
 * Runs unqualified inside each tenant schema (and the source template), with
 * `search_path` pinned by the runner.
 *
 * # down — what is and is not reversible
 *
 * Restores the shape the previous release needs, not the exact old bytes:
 *   - `department` is refilled where NULL (employees created after `up`) from
 *     the linked department's code when it is one of the eight legacy labels,
 *     else 'operations' — the previous release's non-null GraphQL field would
 *     otherwise fail the whole employee list. The real placement stays in
 *     `departmentHrId`; the fallback value is a guess and is lossy by nature.
 *   - NOT NULL is re-imposed and the (tenantId, department) index re-created.
 *   - Placements that `up` derived from `department` are unlinked and the
 *     departments `up` inserted are deleted, but only when nothing references
 *     them any more (employees, child departments, schedules, attendance, finance
 *     entries). An employee an admin moved to another department after `up` no longer
 *     points at the inserted one, so it keeps its placement.
 *   - Attendance is NOT touched. The `departmentId` snapshot step 4 wrote cannot
 *     be told apart afterwards from one a clock-in wrote (both are the employee's
 *     department at the time), and a record pointing at a deleted department is
 *     worse than one pointing at a department that survives. So a department `up`
 *     inserted that an attendance record now references is KEPT (live, still
 *     marked, its employees unlinked) and a later `up` reuses it.
 *   - NOT reversible: links to departments that already existed (they cannot
 *     be told apart from admin assignments), departments revived from
 *     soft-delete (they stay live) and the attendance snapshot above.
 */

/** The TypeORM-named index the Baseline built on employees ("tenantId", "department"). */
const LEGACY_DEPARTMENT_INDEX = 'IDX_c0e4b9f3e9e82b05072fce2069';

/** Prefix of `departments_hr.description` on the rows `up` inserts; `down` deletes by it. */
const BACKFILL_MARKER = 'Backfilled by migration 1802500000000';

/** The retired `employees.department` enum labels, only needed to reverse the data in `down`. */
const LEGACY_DEPARTMENT_LABELS = [
  'operations',
  'maintenance',
  'feeding',
  'quality_control',
  'administration',
  'management',
  'logistics',
  'security',
] as const;

/** Value `down` gives a legacy-less employee whose department code is not a legacy label. */
const LEGACY_DEPARTMENT_FALLBACK = 'operations';

/**
 * `employees.department` changes nullability only when it is not already in the target shape, so a
 * replay (or a database that already has it) is a no-op, not a silent repeat. The information_schema
 * probe is pinned to the schema the runner selected (`current_schema()`).
 */
const DEPARTMENT_COLUMN_IS_NOT_NULL = `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'employees' AND column_name = 'department' AND is_nullable = 'NO')`;
const DEPARTMENT_COLUMN_IS_NULLABLE = `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'employees' AND column_name = 'department' AND is_nullable = 'YES')`;
const DROP_DEPARTMENT_NOT_NULL = `DO $$ BEGIN IF ${DEPARTMENT_COLUMN_IS_NOT_NULL} THEN ALTER TABLE "employees" ALTER COLUMN "department" DROP NOT NULL; END IF; END $$`;
const SET_DEPARTMENT_NOT_NULL = `DO $$ BEGIN IF ${DEPARTMENT_COLUMN_IS_NULLABLE} THEN ALTER TABLE "employees" ALTER COLUMN "department" SET NOT NULL; END IF; END $$`;

/**
 * The employees the backfill is about (alias `e`): live, not yet placed in a
 * department, and still carrying a legacy value to place them by. One
 * predicate for the revive, insert, link and the probe, so they cannot drift.
 */
const UNPLACED_WITH_LEGACY_VALUE = `e."isDeleted" = false AND e."departmentHrId" IS NULL AND e."department" IS NOT NULL`;

/**
 * The (tenantId, legacy value) pairs the backfill has to find a department for. The revive and the
 * insert both start from it, so they ask about exactly the same labels.
 */
const LEGACY_VALUES_TO_PLACE = `
  SELECT DISTINCT e."tenantId", e."department"::text AS "legacyValue"
  FROM "employees" e
  WHERE ${UNPLACED_WITH_LEGACY_VALUE}`;

/**
 * Whether a department code stands for a legacy label: `upper` on both sides, so 'Management' and
 * 'MANAGEMENT' are the same department. The one matching rule of the revive, the insert and the link.
 */
const codeMatches = (code: string, legacyValue: string): string =>
  `upper(${code}) = upper(${legacyValue})`;

/**
 * Which of several matching departments (alias `d`) is THE one: the row whose code is exactly the
 * upper-cased label, then the earliest `createdAt`, then the lowest `id`. A total order, so the
 * choice cannot depend on row order or change on a replay. Used by the revive and the link.
 */
const PREFERRED_DEPARTMENT_FIRST = `(d."code" = upper(d."code")) DESC, d."createdAt" ASC, d."id" ASC`;

/** Departments this migration inserted (alias `d`). */
const INSERTED_BY_THIS_MIGRATION = `d."description" LIKE '${BACKFILL_MARKER}:%'`;

/**
 * The backfill and its probe read and write tables under a FORCEd tenant
 * policy with no tenant bound; `set_config(..., true)` is transaction-local,
 * so outside a transaction it would last one statement and silently leave the
 * rest of the migration blind. Refuse to run that way.
 */
function assertInTransaction(queryRunner: QueryRunner, migrationName: string): void {
  if (!queryRunner.isTransactionActive) {
    throw new Error(
      `${migrationName} sets app.bypass_rls transaction-locally and must run inside the runner's transaction`,
    );
  }
}

async function setRlsBypass(queryRunner: QueryRunner, on: boolean): Promise<void> {
  await queryRunner.query(
    `SELECT pg_catalog.set_config('app.bypass_rls', '${on ? 'on' : 'off'}', true)`,
  );
}

export class RetireEmployeeLegacyDepartment1802500000000 implements MigrationInterface {
  name = 'RetireEmployeeLegacyDepartment1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    assertInTransaction(queryRunner, this.name);

    // A bounded wait: a hot employees table must fail this migration closed (the deploy
    // aborts and an operator re-runs it) rather than queue every writer behind the lock request.
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);

    await queryRunner.query(DROP_DEPARTMENT_NOT_NULL);

    await setRlsBypass(queryRunner, true);

    // Revive a soft-deleted department that still holds a legacy code — but only for a label no
    // live department matches (case-insensitively), and ONE per label: the preferred row.
    await queryRunner.query(`
      WITH "legacy" AS (${LEGACY_VALUES_TO_PLACE}),
      "revivable" AS (
        SELECT DISTINCT ON (legacy."tenantId", legacy."legacyValue") d."id"
        FROM "legacy" legacy
        JOIN "departments_hr" d
          ON d."tenantId" = legacy."tenantId"
         AND ${codeMatches('d."code"', 'legacy."legacyValue"')}
        WHERE d."isDeleted" = true
          AND NOT EXISTS (
            SELECT 1 FROM "departments_hr" live
            WHERE live."tenantId" = legacy."tenantId"
              AND live."isDeleted" = false
              AND ${codeMatches('live."code"', 'legacy."legacyValue"')}
          )
        ORDER BY legacy."tenantId", legacy."legacyValue", ${PREFERRED_DEPARTMENT_FIRST}
      )
      UPDATE "departments_hr" d
      SET "isDeleted" = false,
          "deletedAt" = NULL,
          "deletedBy" = NULL,
          "updatedAt" = now(),
          "version" = d."version" + 1
      FROM "revivable" r
      WHERE d."id" = r."id"
    `);

    // Insert the departments no row yet stands for, live or soft-deleted, whatever its letter case.
    // ON CONFLICT DO NOTHING (no target, so it needs no particular index to exist) covers a
    // department an old container creates with the same code mid-statement.
    await queryRunner.query(`
      INSERT INTO "departments_hr" ("tenantId", "name", "code", "description", "version")
      SELECT legacy."tenantId",
             initcap(replace(legacy."legacyValue", '_', ' ')),
             upper(legacy."legacyValue"),
             '${BACKFILL_MARKER}: ' || legacy."legacyValue",
             1
      FROM (${LEGACY_VALUES_TO_PLACE}) legacy
      WHERE NOT EXISTS (
        SELECT 1 FROM "departments_hr" d
        WHERE d."tenantId" = legacy."tenantId"
          AND ${codeMatches('d."code"', 'legacy."legacyValue"')}
      )
      ON CONFLICT DO NOTHING
    `);

    // Place every unplaced employee in THE live department its legacy value stands for, and give
    // the attendance records those employees already own (snapshot still NULL) the same
    // department. One statement: the employees this run placed come back through RETURNING, the
    // only exact record of which employees those are. Only NULL links and NULL snapshots are
    // touched, so a replay is a no-op and neither an admin's assignment nor a snapshot a
    // clock-in wrote is overwritten.
    await queryRunner.query(`
      WITH "chosen" AS (
        SELECT DISTINCT ON (d."tenantId", upper(d."code"))
               d."tenantId", upper(d."code") AS "legacyCode", d."id"
        FROM "departments_hr" d
        WHERE d."isDeleted" = false
        ORDER BY d."tenantId", upper(d."code"), ${PREFERRED_DEPARTMENT_FIRST}
      ),
      "placed" AS (
        UPDATE "employees" e
        SET "departmentHrId" = c."id"
        FROM "chosen" c
        WHERE ${UNPLACED_WITH_LEGACY_VALUE}
          AND c."tenantId" = e."tenantId"
          AND ${codeMatches('c."legacyCode"', 'e."department"::text')}
        RETURNING e."id", e."tenantId", e."departmentHrId"
      )
      UPDATE "attendance_records" a
      SET "departmentId" = p."departmentHrId"::text
      FROM "placed" p
      WHERE a."tenantId" = p."tenantId"
        AND a."employeeId" = p."id"
        AND a."departmentId" IS NULL
    `);

    await setRlsBypass(queryRunner, false);

    await queryRunner.query(`DROP INDEX IF EXISTS "${LEGACY_DEPARTMENT_INDEX}"`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // The runner calls this inside the migration's transaction, so the bypass
    // set here ends with it; without it the "no unplaced employee" probe
    // would see no rows and pass for the wrong reason.
    await setRlsBypass(queryRunner, true);
    const rows = (await queryRunner.query(`
      SELECT
        COALESCE((
          SELECT c.is_nullable = 'YES'
          FROM information_schema.columns c
          WHERE c.table_schema = current_schema()
            AND c.table_name = 'employees'
            AND c.column_name = 'department'
        ), false)
        AND NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = '${LEGACY_DEPARTMENT_INDEX}'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "employees" e WHERE ${UNPLACED_WITH_LEGACY_VALUE}
        ) AS ok
    `)) as Array<{ ok: boolean }>;
    await setRlsBypass(queryRunner, false);
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertInTransaction(queryRunner, this.name);
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await setRlsBypass(queryRunner, true);

    // 1. Unlink the placements `up` derived from `department` (the employee still carries the legacy
    //    value that matches the inserted department's code). Done BEFORE the refill below: an employee
    //    created after `up` has no legacy value yet, and one an admin moved elsewhere no longer points
    //    at the inserted department, so neither matches here — they keep their placement, and the
    //    department they point to survives step 3.
    await queryRunner.query(`
      UPDATE "employees" e
      SET "departmentHrId" = NULL
      FROM "departments_hr" d
      WHERE d."id" = e."departmentHrId"
        AND ${INSERTED_BY_THIS_MIGRATION}
        AND upper(e."department"::text) = d."code"
    `);

    // 2. Give every employee created after `up` a `department` again. The literal takes the column's
    //    own enum type (as 1801600000000 does for laborCategory), so no enum type name is spelled here.
    for (const label of LEGACY_DEPARTMENT_LABELS) {
      await queryRunner.query(`
        UPDATE "employees" e
        SET "department" = '${label}'
        FROM "departments_hr" d
        WHERE e."department" IS NULL
          AND d."id" = e."departmentHrId"
          AND lower(d."code") = '${label}'
      `);
    }
    await queryRunner.query(
      `UPDATE "employees" SET "department" = '${LEGACY_DEPARTMENT_FALLBACK}' WHERE "department" IS NULL`,
    );

    // 3. Delete the departments `up` inserted that nothing refers to any more. Anything an admin
    //    attached to such a department afterwards (an employee, a child department, a schedule,
    //    attendance or a finance entry) keeps it alive — and so does an attendance record `up`
    //    itself snapshotted: attendance is left as it is (see the doc comment), never re-pointed.
    await queryRunner.query(`
      DELETE FROM "departments_hr" d
      WHERE ${INSERTED_BY_THIS_MIGRATION}
        AND NOT EXISTS (SELECT 1 FROM "employees" e WHERE e."departmentHrId" = d."id")
        AND NOT EXISTS (SELECT 1 FROM "departments_hr" child WHERE child."parentDepartmentId" = d."id"::text)
        AND NOT EXISTS (SELECT 1 FROM "schedules" s WHERE s."departmentId"::text = d."id"::text)
        AND NOT EXISTS (SELECT 1 FROM "attendance_records" a WHERE a."departmentId"::text = d."id"::text)
        AND NOT EXISTS (SELECT 1 FROM "hr_finance_entries" f WHERE f."departmentHrId"::text = d."id"::text)
    `);

    await setRlsBypass(queryRunner, false);

    // 4. The previous release's shape: NOT NULL (no NULL is left) and the index.
    await queryRunner.query(SET_DEPARTMENT_NOT_NULL);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${LEGACY_DEPARTMENT_INDEX}" ON "employees" ("tenantId", "department")`,
    );
  }
}
