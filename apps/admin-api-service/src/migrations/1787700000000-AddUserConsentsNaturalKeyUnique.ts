import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddUserConsentsNaturalKeyUnique1787700000000
 * ============================================================================
 *
 * Adds a UNIQUE index on `shared.user_consents (userId, consentType, version)`.
 * Each tuple represents a single consent decision a user made — two rows
 * claiming the SAME tuple is data corruption that violates the audit
 * invariant of GDPR Art 7(1) ("controller must demonstrate the data
 * subject HAS consented").
 *
 * # Why
 *
 * AUDIT FINDING: DBR-MEDIUM-004. The user_consents table previously
 * had only non-unique single-column indexes. Application code relied
 * on row-by-row validation to prevent duplicates, which is the
 * make-detectable Tier-3 layer at best — a race between two parallel
 * consent submissions could insert two rows with the same natural
 * key. The DB-level unique constraint is the make-impossible Tier-1
 * cure.
 *
 * # Pre-flight: orphan handling
 *
 * Pre-flight detects pre-existing duplicate (userId, consentType,
 * version) tuples and fails-loud. Operator runbook: pick the
 * canonical row (typically: latest createdAt) and soft-delete or
 * hard-delete the duplicates after capturing audit evidence.
 *
 * # Why CONCURRENTLY
 *
 * `shared.user_consents` is a pre-existing live-writer table;
 * migration-sql-lint R3 mandates CONCURRENTLY.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-004
 */
export class AddUserConsentsNaturalKeyUnique1787700000000
  implements MigrationInterface
{
  name = 'AddUserConsentsNaturalKeyUnique1787700000000';

  // CONCURRENTLY cannot run inside a transaction.
  transaction: 'none' = 'none';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const offenders: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM (
        SELECT "userId", "consentType", "version"
        FROM shared.user_consents
        GROUP BY "userId", "consentType", "version"
        HAVING COUNT(*) > 1
      ) AS multi
    `);
    const offenderCount = Number(offenders[0]?.count ?? '0');
    if (offenderCount > 0) {
      throw new Error(
        `Refusing to install unique index on shared.user_consents(userId, consentType, version): ` +
          `${offenderCount} natural-key tuple(s) currently have MORE THAN ONE row. ` +
          'Run docs/runbooks/user-consents-natural-key-duplicate-triage.md to ' +
          'pick the canonical row + remove duplicates (with audit evidence) before re-applying.',
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_consent_user_type_version"
        ON shared.user_consents ("userId", "consentType", "version")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS shared."UQ_consent_user_type_version"`);
  }
}
