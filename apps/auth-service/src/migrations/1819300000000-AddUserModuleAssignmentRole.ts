import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddUserModuleAssignmentRole1819300000000 (RBAC-HIGH-027; ADR-051 §2, plan PKG-04, release R1)
 *
 * WHY: a module grant carried no role. `user_module_assignments` held only `isPrimaryManager`,
 * which token mint never read, so the per-module manager choice was lost and the tenant-wide
 * `users.role` made a manager of one module a manager of every module. The grant now carries its
 * role, MODULE_MANAGER or MODULE_USER, from which the `moduleAccess` token claim is built.
 *
 * Blue-green (C3): the column is added NULLABLE with no default. The containers of the previous
 * release keep inserting rows without it until they are replaced; such a row grants nothing in
 * the claim. 1819400000000 backfills the existing rows; PKG-06 re-runs that backfill and sets
 * NOT NULL in release R3, in its own migration. No row is rewritten here: adding a nullable
 * column without a default changes only the catalog.
 *
 * The CHECK makes the module roles a property of the store, so no writer can persist an account
 * role as a grant. Every value is NULL when it is added, so its validation scan is trivial. It is
 * mirrored by the @Check on the entity, which keeps the drift validator's class-G count even.
 * PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so the constraint is guarded on pg_constraint.
 */
export class AddUserModuleAssignmentRole1819300000000 implements MigrationInterface {
  name = 'AddUserModuleAssignmentRole1819300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      ALTER TABLE "auth"."user_module_assignments"
        ADD COLUMN IF NOT EXISTS "role" character varying(32)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_user_module_assignments_role'
             AND conrelid = 'auth.user_module_assignments'::regclass
        ) THEN
          ALTER TABLE "auth"."user_module_assignments"
            ADD CONSTRAINT "CHK_user_module_assignments_role" CHECK ("role" IN ('MODULE_MANAGER', 'MODULE_USER'));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."user_module_assignments"
        DROP CONSTRAINT IF EXISTS "CHK_user_module_assignments_role"
    `);
    await queryRunner.query(`
      ALTER TABLE "auth"."user_module_assignments" DROP COLUMN IF EXISTS "role"
    `);
  }
}
