import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the auth.user_site_assignments table (SEC-HIGH-051).
 *
 * WHY: object-level site authorization needs a user->site membership link.
 * None existed (only supplier->site + user_module_assignments). This table is
 * that SSoT — {@link UserSiteAssignment} entity is synchronize:false; this
 * migration is the schema owner.
 *
 * WHAT: a single source-owned table in the `auth` schema mirroring the
 * user_module_assignments shape. PLATFORM / cross-tenant — never cloned into
 * tenant schemas (hence @SourceOnlyMigration + pinSearchPath('auth')).
 *
 * Blue-green safe: pure additive CREATE TABLE with no NOT NULL backfill on an
 * existing table. FK on userId -> auth.users(id) ON DELETE CASCADE so a deleted
 * user's site assignments are removed automatically. siteId carries NO FK: it
 * is a cross-service farm-service Site id, never a row in the auth schema.
 *
 * Picked up by the src/migrations/[0-9]*.ts glob — no manifest array to edit.
 */
@SourceOnlyMigration({
  reason:
    'user_site_assignments is source-owned auth infrastructure and must never be cloned into tenant schemas',
})
export class CreateUserSiteAssignments1801100000000 implements MigrationInterface {
  name = 'CreateUserSiteAssignments1801100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.user_site_assignments (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "siteId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "assignedBy" UUID NOT NULL,
        "expiresAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_site" UNIQUE ("userId", "siteId"),
        CONSTRAINT "FK_user_site_assignments_user"
          FOREIGN KEY ("userId") REFERENCES auth.users("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_site_assignments_user"
        ON auth.user_site_assignments ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_site_assignments_tenant"
        ON auth.user_site_assignments ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await queryRunner.query(`DROP INDEX IF EXISTS auth."IDX_user_site_assignments_tenant"`);
    await queryRunner.query(`DROP INDEX IF EXISTS auth."IDX_user_site_assignments_user"`);
    await queryRunner.query(`DROP TABLE IF EXISTS auth.user_site_assignments`);
  }
}
