import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddImpersonationPermissionRevocationAudit — record WHO revoked a super-admin's
 * impersonation permission, and WHEN.
 *
 * Revoking impersonation permission is one of the most security-relevant actions
 * the platform offers: it strips an operator's ability to enter tenant data and
 * ends every session they hold. `revokeImpersonationPermission` flipped
 * `isActive` and `canImpersonate` to false and recorded nothing else — no actor,
 * no timestamp. `updatedAt` moved, but it moves for every write, so it cannot
 * answer "who did this".
 *
 * The admin panel's Permissions tab had a Revoked table with `Revoked By` and
 * `Revoked At` columns reading fields that did not exist. Those columns were
 * asking the right question; the model had no answer to give.
 *
 * # SAFETY SHAPE (blue-green safe, idempotent)
 *   * Two nullable columns. No backfill — rows revoked before this release
 *     genuinely have no record, and inventing one would be worse than NULL.
 *   * No NOT NULL step, no index, no rewrite of existing rows.
 *   * The previous release ignores both columns; the new release writes them on
 *     revoke only. Both can run against this schema at once.
 */
export class AddImpersonationPermissionRevocationAudit1802600000000
  implements MigrationInterface
{
  name = 'AddImpersonationPermissionRevocationAudit1802600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ADD COLUMN IF NOT EXISTS "revokedBy" UUID NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      DROP COLUMN IF EXISTS "revokedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      DROP COLUMN IF EXISTS "revokedBy"
    `);
  }
}
