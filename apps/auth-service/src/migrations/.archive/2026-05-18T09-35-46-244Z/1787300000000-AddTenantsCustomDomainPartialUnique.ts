import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTenantsCustomDomainPartialUnique1787300000000
 * ============================================================================
 *
 * Adds a PARTIAL unique index on `auth.tenants.customDomain WHERE
 * customDomain IS NOT NULL` so two tenants cannot both claim the same
 * enterprise host header.
 *
 * # Why
 *
 * AUDIT FINDING: DBR-MEDIUM-001 captured the gap. The
 * customDomain column is consumed by the gateway's host-based
 * tenant-resolution path; allowing duplicate non-null values would
 * map a single inbound host (e.g., `acme.aquaculture.com`) to two
 * different tenant rows, producing routing ambiguity. The vast
 * majority of tenants leave customDomain NULL (default sub-domain
 * routing); a FULL unique would collide on the bare-NULL pile, so
 * the constraint is PARTIAL on non-null rows.
 *
 * # Pre-flight
 *
 * Before installing the constraint we check for any pre-existing
 * duplicate non-null customDomain values. If found, fail-loud — the
 * collision is a data-corruption signal needing operator triage,
 * NOT silent fix.
 *
 * # Why CONCURRENTLY
 *
 * `auth.tenants` is a pre-existing live-writer table; migration-sql-
 * lint R3 mandates CREATE INDEX CONCURRENTLY here. The migration
 * sets `transaction = 'none'` because CONCURRENTLY cannot run inside
 * a multi-statement transaction block.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-001
 */
export class AddTenantsCustomDomainPartialUnique1787300000000
  implements MigrationInterface
{
  name = 'AddTenantsCustomDomainPartialUnique1787300000000';

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const offenders: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM (
        SELECT "customDomain"
        FROM auth.tenants
        WHERE "customDomain" IS NOT NULL
        GROUP BY "customDomain"
        HAVING COUNT(*) > 1
      ) AS multi
    `);
    const offenderCount = Number(offenders[0]?.count ?? '0');
    if (offenderCount > 0) {
      throw new Error(
        `Refusing to install partial unique index on auth.tenants(customDomain): ` +
          `${offenderCount} customDomain value(s) are claimed by MORE THAN ONE tenant. ` +
          'Run docs/runbooks/auth-tenants-duplicate-custom-domain-triage.md to ' +
          'NULL or rename the duplicate(s) before re-applying.',
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_tenants_customDomain"
        ON auth.tenants ("customDomain")
        WHERE "customDomain" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS auth."UQ_tenants_customDomain"`);
  }
}
