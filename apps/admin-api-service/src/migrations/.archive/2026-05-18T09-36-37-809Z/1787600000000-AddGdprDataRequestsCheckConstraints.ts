import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddGdprDataRequestsCheckConstraints1787600000000
 * ============================================================================
 *
 * Adds CHECK constraints on `shared.gdpr_data_requests.requestType` and
 * `.status` so the columns can only hold the values declared by the
 * canonical TypeScript enums (DataRequestType + DataRequestStatus).
 *
 * # Why this matters
 *
 * AUDIT FINDING: DBR-HIGH-005 captured that both columns are typed as
 * `varchar(50)` with NO database-level value enforcement despite their
 * GDPR-SLA criticality. Misspelling, drift between application enum
 * and DB allowed values, or a malicious operator inserting a non-
 * canonical status (e.g. `'completed_secretly'`) would all be accepted
 * silently — corrupting the SLA-tracked GDPR request lifecycle.
 *
 * Pre-fix every consumer of these columns trusted the application
 * layer to enforce the enum. The CHECK constraint is the Tier-3
 * make-detectable defence-in-depth: any direct DB write that bypasses
 * the application (raw SQL, third-party tooling, future migration
 * hand-edit) errors out instead of silently corrupting the trail.
 *
 * # Why CHECK and not DB enum
 *
 * Postgres native enums require a separate ADR for every value
 * addition + a column-type ALTER per change. CHECK constraints are
 * cheaper to update — adding a new request type means dropping the
 * constraint and re-creating it with the new value list, no column-
 * level rewrite. Application code already uses the TypeScript enum
 * as the canonical value list; CHECK mirrors that without compounding
 * the migration overhead.
 *
 * # Pre-flight: drift detection
 *
 * Before adding the constraint we check the table for any pre-
 * existing rows whose values fall OUTSIDE the canonical enum. Any
 * such row is a data-corruption signal that needs operator triage.
 * Silently accepting them via NOT VALID would mask the corruption.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-HIGH-005
 */
export class AddGdprDataRequestsCheckConstraints1787600000000
  implements MigrationInterface
{
  name = 'AddGdprDataRequestsCheckConstraints1787600000000';

  // Mirrors libs/backend-common/src/security/gdpr/entities/data-request.entity.ts
  // exports of DataRequestType + DataRequestStatus. Keep these lists in
  // strict lock-step — adding an enum value to TypeScript without
  // updating this migration's CHECK list would cause the next deploy
  // to reject the new value at the DB layer (a feature, not a bug —
  // the developer learns about the mismatch before users do).
  private static readonly REQUEST_TYPE_VALUES = [
    'export',
    'deletion',
    'rectification',
    'restriction',
    'portability',
  ];
  private static readonly STATUS_VALUES = [
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-flight: detect rows that already violate the constraint.
    const tList = AddGdprDataRequestsCheckConstraints1787600000000.REQUEST_TYPE_VALUES
      .map((v) => `'${v}'`)
      .join(',');
    const sList = AddGdprDataRequestsCheckConstraints1787600000000.STATUS_VALUES
      .map((v) => `'${v}'`)
      .join(',');

    const offendingType: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM shared.gdpr_data_requests
      WHERE "requestType" IS NOT NULL
        AND "requestType" NOT IN (${tList})
    `);
    const offendingStatus: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM shared.gdpr_data_requests
      WHERE "status" IS NOT NULL
        AND "status" NOT IN (${sList})
    `);
    const tCount = Number(offendingType[0]?.count ?? '0');
    const sCount = Number(offendingStatus[0]?.count ?? '0');
    if (tCount > 0 || sCount > 0) {
      throw new Error(
        `Refusing to add gdpr_data_requests CHECK constraints: ` +
          `${tCount} row(s) have non-canonical requestType, ` +
          `${sCount} row(s) have non-canonical status. ` +
          'Run docs/runbooks/gdpr-data-requests-value-triage.md to map ' +
          'pre-existing values onto the canonical enum (or open an ADR ' +
          'extending the enum list) before re-applying.',
      );
    }

    // Idempotent — drop if exists (defence against partial earlier run).
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      DROP CONSTRAINT IF EXISTS "CK_gdpr_data_requests_requestType"
    `);
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      DROP CONSTRAINT IF EXISTS "CK_gdpr_data_requests_status"
    `);

    // CHECK constraints. NOT VALID would skip the existing-rows scan,
    // but we already pre-flighted them above, so a hard CHECK is fine.
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      ADD CONSTRAINT "CK_gdpr_data_requests_requestType"
      CHECK ("requestType" IN (${tList}))
    `);
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      ADD CONSTRAINT "CK_gdpr_data_requests_status"
      CHECK ("status" IN (${sList}))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down is permitted — removing the CHECK constraint does not
    // destroy data; future application-layer validation is the only
    // remaining gate. Operators may need to drop these temporarily
    // for a planned-migration scenario where new enum values are
    // introduced in stages.
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      DROP CONSTRAINT IF EXISTS "CK_gdpr_data_requests_status"
    `);
    await queryRunner.query(`
      ALTER TABLE shared.gdpr_data_requests
      DROP CONSTRAINT IF EXISTS "CK_gdpr_data_requests_requestType"
    `);
  }
}
