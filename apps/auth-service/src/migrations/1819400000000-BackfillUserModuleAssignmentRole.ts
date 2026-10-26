import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

const MIGRATION_NAME = 'BackfillUserModuleAssignmentRole1819400000000';

/** The note on a row this migration inserts for a tenant_modules.managerId. */
const MANAGER_ID_ROW_NOTE = `Inserted from tenant_modules.managerId by ${MIGRATION_NAME}`;

/**
 * A designated module manager (tenant_modules.managerId) of the same tenant gets a manager row
 * where none exists. Assign Manager wrote only managerId and users.role, never a grant, so such a
 * manager may have no row for the module they manage. hr is left out: an hr manager grant comes
 * only from isPrimaryManager (D6), and this migration creates no hr grant that did not exist.
 * alert and ai own no data and carry no grant.
 */
const INSERT_DESIGNATED_MANAGERS_SQL = `
  WITH inserted AS (
    INSERT INTO "auth"."user_module_assignments"
      ("userId", "moduleId", "tenantId", "isPrimaryManager", "isActive", "assignedBy", "notes", "role")
    SELECT tm."managerId", tm."moduleId", tm."tenantId", false, true, tm."managerId", $1, 'MODULE_MANAGER'
      FROM "auth"."tenant_modules" tm
      JOIN "auth"."modules" m ON m."id" = tm."moduleId"
      JOIN "auth"."users" u ON u."id" = tm."managerId" AND u."tenantId" = tm."tenantId"
     WHERE tm."managerId" IS NOT NULL
       AND m."code" IN ('farm', 'sensor', 'hydroponics')
    ON CONFLICT ("userId", "moduleId") DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS "inserted" FROM inserted`;

/**
 * The ADR-051 rule, for every row still without a role: the primary manager manages the module
 * (hr included); a designated manager (managerId) or a legacy global MODULE_MANAGER manages any
 * module but hr; everyone else uses it. Rows that already hold a role — written by the live
 * writers, which apply the same rule (assignment-module-role.ts) — are never recomputed, so a
 * re-run (PKG-06 in R3) fills only the rows containers of the previous release inserted.
 */
const SET_ROLES_SQL = `
  WITH updated AS (
    UPDATE "auth"."user_module_assignments" uma
       SET "role" = CASE
         WHEN uma."isPrimaryManager" THEN 'MODULE_MANAGER'
         WHEN m."code" <> 'hr'
          AND (u."role" = 'MODULE_MANAGER'
               OR EXISTS (
                 SELECT 1 FROM "auth"."tenant_modules" tm
                  WHERE tm."tenantId" = uma."tenantId"
                    AND tm."moduleId" = uma."moduleId"
                    AND tm."managerId" = uma."userId"))
         THEN 'MODULE_MANAGER'
         ELSE 'MODULE_USER'
       END
      FROM "auth"."modules" m, "auth"."users" u
     WHERE m."id" = uma."moduleId"
       AND u."id" = uma."userId"
       AND uma."role" IS NULL
    RETURNING uma."role"
  )
  SELECT count(*) FILTER (WHERE "role" = 'MODULE_MANAGER')::int AS "managers",
         count(*) FILTER (WHERE "role" = 'MODULE_USER')::int AS "users"
    FROM updated`;

const REMAINING_SQL = `
  SELECT count(*)::int AS "remaining" FROM "auth"."user_module_assignments" WHERE "role" IS NULL`;

/** hr managers designated by managerId who hold no hr manager grant: the operator's list (D6). */
const HR_DESIGNATED_WITHOUT_GRANT_SQL = `
  SELECT count(*)::int AS "hrDesignatedWithoutGrant"
    FROM "auth"."tenant_modules" tm
    JOIN "auth"."modules" m ON m."id" = tm."moduleId"
   WHERE tm."managerId" IS NOT NULL
     AND m."code" = 'hr'
     AND NOT EXISTS (
       SELECT 1 FROM "auth"."user_module_assignments" uma
        WHERE uma."userId" = tm."managerId"
          AND uma."moduleId" = tm."moduleId"
          AND uma."role" = 'MODULE_MANAGER')`;

/** The one row a count query returns, read as a number. */
function countOf(rows: unknown, column: string): number {
  const [row]: unknown[] = Array.isArray(rows) ? rows : [];
  const value: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, column) : null;
  if (typeof value !== 'number') {
    throw new Error(`${MIGRATION_NAME}: the ${column} count returned no number`);
  }
  return value;
}

/**
 * BackfillUserModuleAssignmentRole1819400000000 (RBAC-HIGH-027; ADR-051 §2 "Backfill", plan
 * PKG-04, release R1)
 *
 * Gives every existing module grant the role 1819300000000 added, counted:
 *
 *   1. a designated manager without a row for a farm, sensor or hydroponics module gets one;
 *   2. every row without a role gets MODULE_MANAGER from isPrimaryManager, from managerId or
 *      from the legacy global MODULE_MANAGER (hr only from isPrimaryManager), else MODULE_USER;
 *   3. post-condition: no row is left without a role — a row whose user or module does not join
 *      fails the migration rather than leave a grant nobody can read;
 *   4. the counts are logged, with the hr managers designated by managerId who received no hr
 *      manager grant, for the operator's grant review (PKG-06).
 *
 * auth.user_module_assignments holds one row per member and module, so one bounded transaction
 * (lock_timeout 5s, statement_timeout 60s) suffices. auth tables carry no row-level security
 * (auth is cross-tenant by design, D14). Idempotent: step 1 inserts on conflict nothing, step 2
 * touches only rows without a role, so a replay writes nothing.
 *
 * `down` is a no-op: the roles are indistinguishable from the ones the live writers write, and
 * 1819300000000's `down` drops the column. The inserted rows carry MANAGER_ID_ROW_NOTE.
 */
export class BackfillUserModuleAssignmentRole1819400000000 implements MigrationInterface {
  name = MIGRATION_NAME;

  private readonly logger = new Logger(MIGRATION_NAME);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    const inserted = countOf(
      await queryRunner.query(INSERT_DESIGNATED_MANAGERS_SQL, [MANAGER_ID_ROW_NOTE]),
      'inserted',
    );
    const roles: unknown = await queryRunner.query(SET_ROLES_SQL);
    const managers = countOf(roles, 'managers');
    const users = countOf(roles, 'users');
    const remaining = countOf(await queryRunner.query(REMAINING_SQL), 'remaining');
    if (remaining !== 0) {
      throw new Error(
        `${MIGRATION_NAME}: ${remaining} user_module_assignments row(s) have no role after the backfill`,
      );
    }
    const hrDesignatedWithoutGrant = countOf(
      await queryRunner.query(HR_DESIGNATED_WITHOUT_GRANT_SQL),
      'hrDesignatedWithoutGrant',
    );

    this.logger.log(
      JSON.stringify({
        event: 'user_module_assignment_role_backfill',
        managerIdRowsInserted: inserted,
        managers,
        users,
        hrDesignatedWithoutGrant,
      }),
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only — see the class docblock.
  }
}
