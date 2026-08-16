import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `admin.impersonation_sessions` is a lifecycle state machine, not an
 * append-only ledger. The baseline installed an unconditional BEFORE UPDATE OR
 * DELETE trigger, so every end, expiry, extension, termination, and action-log
 * transition failed after the initial INSERT.
 *
 * The table remains destructive-DDL protected and hard-delete protected. This
 * migration removes only the erroneous UPDATE prohibition, then establishes a
 * dedicated DELETE guard. Its policy is owned by
 * `PROTECTED_TABLE_POLICIES`; both baseline tools derive from that SSoT, so a
 * future baseline cannot regenerate the category error.
 */
export class ClassifyImpersonationSessionsLifecycle1808300000000 implements MigrationInterface {
  name = 'ClassifyImpersonationSessionsLifecycle1808300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update
      ON "admin"."impersonation_sessions"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "admin".impersonation_sessions_prevent_update_or_delete()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_sessions_prevent_delete()
      RETURNS trigger AS $impersonation_retention_guard$
      BEGIN
        RAISE EXCEPTION
          'admin.impersonation_sessions is lifecycle-mutated and retention-guarded; hard DELETE is not permitted';
      END;
      $impersonation_retention_guard$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_delete
      ON "admin"."impersonation_sessions"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_impersonation_sessions_prevent_delete
      BEFORE DELETE ON "admin"."impersonation_sessions"
      FOR EACH ROW
      EXECUTE FUNCTION "admin".impersonation_sessions_prevent_delete()
    `);
    await queryRunner.query(`
      REVOKE DELETE ON "admin"."impersonation_sessions" FROM PUBLIC
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Refusing to rollback 1808300000000-ClassifyImpersonationSessionsLifecycle: ' +
        'reinstalling the BEFORE UPDATE guard would disable every impersonation ' +
        'session lifecycle transition. Roll forward with a corrective migration.',
    );
  }
}
