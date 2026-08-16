import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make one PostgreSQL row the projection authority for each super-admin's
 * impersonation grant and persist explicit revocation facts.
 *
 * The previous non-unique `(superAdminId, isActive)` index allowed concurrent
 * first grants to create two mutation authorities. It also exposed a
 * `notifyTenantAdmin=true` default although the only implementation was a log
 * line, so the stored state could claim a notification policy that did not
 * exist. This migration fails closed if duplicate authorities already exist,
 * installs the unique key, disables the fictional notification flag, and adds
 * the nullable revocation projection used by the admin read model. Historical
 * revocations remain null rather than receiving invented actor/time values.
 *
 * The immutable, transaction-coupled record of grant/revoke operations remains
 * `admin.audit_logs`; these columns are the current-state projection.
 */
export class HardenImpersonationPermissionAuthority1808400000000 implements MigrationInterface {
  name = 'HardenImpersonationPermissionAuthority1808400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "admin"."impersonation_permissions"
          GROUP BY "superAdminId"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION
            'Duplicate impersonation permission authorities exist; reconcile them before migration 1808400000000';
        END IF;
      END
      $authority$;
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ADD COLUMN IF NOT EXISTS "revokedBy" uuid NULL,
      ADD COLUMN IF NOT EXISTS "revokedAt" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "revocationReason" text NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ALTER COLUMN "notifyTenantAdmin" SET DEFAULT false
    `);
    await queryRunner.query(`
      UPDATE "admin"."impersonation_permissions"
      SET "notifyTenantAdmin" = false
      WHERE "notifyTenantAdmin" = true
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      "UQ_admin_impersonation_permissions_super_admin"
      ON "admin"."impersonation_permissions" ("superAdminId")
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Refusing to roll back impersonation permission authority hardening: ' +
        'doing so would restore duplicate grant authorities, fictional notification state, ' +
        'and unauditable revocation projections.',
    );
  }
}
