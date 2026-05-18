import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddUserPermissionsUserFk1787900000000
 * ============================================================================
 *
 * Adds the missing FK constraint on `shared.user_permissions.userId` →
 * `auth.users.id` with `ON DELETE CASCADE`. Pre-fix the column was a
 * bare `@Column({ type: 'uuid' })` with no DB-level reference — orphan
 * permission rows survived user hard-delete.
 *
 * # Why this migration exists
 *
 * Permission/authorization tables MUST enforce referential integrity
 * at the DB level. An orphan permission row is a privilege-escalation
 * vector:
 *   - If a user_id is later reused (UUID collision is astronomically
 *     unlikely but not impossible across the system lifetime),
 *     the stale permission grants apply to the new user.
 *   - If a stale permission row gets joined with a different user
 *     record by an upstream bug, the user inherits permissions they
 *     never had granted.
 *
 * DBR-HIGH-004 captured the gap.
 *
 * # Why ON DELETE CASCADE
 *
 * When an auth.users row is deleted (GDPR Art 17 erasure, account
 * cleanup, etc.), all permission rows for that user MUST vanish
 * atomically. CASCADE is the right semantics — a permission row
 * without a user is a phantom grant.
 *
 * # Pre-flight orphan check
 *
 * Before adding the FK, verify there are no orphan rows. If any
 * exist, surface the count fail-loud with a triage pointer rather
 * than letting the ALTER TABLE fail mid-validation with a generic
 * error.
 *
 * # Cross-schema FK note
 *
 * Postgres supports cross-schema FK natively (auth.users → shared
 * referencer). The auth-service service role needs USAGE on the
 * shared schema and SELECT on shared.user_permissions for FK
 * validation; both grants already exist via
 * GrantSharedSchemaPrivileges1787000000000.
 *
 * # Down-rollback
 *
 * Drops the FK. Reverting to the unconstrained state allows orphan
 * rows again — operators using down() should be aware that the
 * post-down state opens the privilege-escalation window.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-HIGH-004
 */
export class AddUserPermissionsUserFk1787900000000
  implements MigrationInterface
{
  name = 'AddUserPermissionsUserFk1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: pre-flight orphan scan.
    //
    // WHY: ALTER TABLE ADD CONSTRAINT validates against existing rows.
    // If a user has been hard-deleted while this migration was missing,
    // the orphan rows abort validation with a generic FK violation.
    // Pre-flight surfaces the problem fail-loud with a triage pointer
    // so operators repair before re-applying.
    const orphans: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM shared.user_permissions up
      WHERE NOT EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = up."userId"
      )
    `);
    const orphanCount = Number(orphans[0]?.count ?? '0');
    if (orphanCount > 0) {
      throw new Error(
        `Refusing to install FK on shared.user_permissions(userId): ` +
          `${orphanCount} permission row(s) reference deleted users. ` +
          'Run docs/runbooks/shared-user-permissions-orphan-triage.md ' +
          'to repair (cascade-delete or restore the user) before re-applying.',
      );
    }

    // Step 2: add canonical FK with explicit ON DELETE CASCADE.
    //
    // WHY: CASCADE — when an auth.users row is deleted, all permission
    // rows for that user MUST vanish atomically. A permission row
    // without a user is a phantom grant; CASCADE eliminates the
    // possibility at the DB level.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'shared'
            AND table_name = 'user_permissions'
            AND constraint_name = 'fk_user_permissions_userId_auth_users'
        ) THEN
          ALTER TABLE shared.user_permissions
            ADD CONSTRAINT fk_user_permissions_userId_auth_users
            FOREIGN KEY ("userId")
            REFERENCES auth.users (id)
            ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shared.user_permissions DROP CONSTRAINT IF EXISTS fk_user_permissions_userId_auth_users
    `);
  }
}
