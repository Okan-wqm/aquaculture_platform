import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add mfaCompleted boolean column to impersonation_sessions.
 *
 * The column was added to the ImpersonationSession entity (ADMIN-MEDIUM-004)
 * but the corresponding database migration was missing, causing a runtime
 * "column ImpersonationSession.mfaCompleted does not exist" error on startup.
 *
 * @see ADMIN-MEDIUM-004
 */
export class AddMfaCompletedToImpersonationSessions1782100000000
  implements MigrationInterface
{
  name = 'AddMfaCompletedToImpersonationSessions1782100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "impersonation_sessions"
      ADD COLUMN IF NOT EXISTS "mfaCompleted" boolean NOT NULL DEFAULT false;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "impersonation_sessions"
      DROP COLUMN IF EXISTS "mfaCompleted";
    `);
  }
}
