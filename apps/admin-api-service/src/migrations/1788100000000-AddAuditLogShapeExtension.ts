import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuditLogShapeExtension1788100000000
 * ============================================================================
 *
 * Adds the 8 mandatory-shape fields the audit-trail-completeness-auditor
 * agent requires on `shared.audit_logs` (AUDITTRAIL-CRITICAL-004 cure).
 *
 * # Why this migration exists
 *
 * Pre-fix `shared.audit_logs` carried 14 columns. The mandatory shape
 * defined by the audit-trail-completeness-auditor agent requires 22.
 * Eight fields were missing, each tied to a regulatory or forensic
 * capability:
 *
 *   - actorHomeTenantId — dual-identity impersonation (SUPER_ADMIN's
 *     home tenant) was crammed into metadata.jsonb (not queryable).
 *     SOC 2 CC1 cross-tenant access reconstruction blocked.
 *   - actedOnTenantId — semantically conflated with the legacy
 *     `tenantId` (which became overloaded between actor scope and
 *     target scope).
 *   - method — cannot distinguish CRON-triggered from HTTP-triggered
 *     actions; forensic timeline ambiguous.
 *   - mfaVerified — only inside metadata.jsonb (not queryable for
 *     SOC 2 CC6.1 step-up evidence reports).
 *   - result — semantically conflated with `severity` (DENIED is
 *     not the same as ERROR).
 *   - preStateHash / postStateHash — mutation integrity cannot be
 *     proven cryptographically; tamper-detection downgraded.
 *   - justification — required for override actions per agent
 *     invariant (admin override of a scheduled change, etc.).
 *   - relatedAuditIds — impersonation session linkage cannot be
 *     reconstructed (start row → end row).
 *
 * # What this migration does
 *
 *   1. ADD COLUMN for each of the 8 fields, nullable for blue-green
 *      backfill safety. NOT NULL on actor/method/result is a
 *      follow-up migration after backfill completes (per agent
 *      docstring: V1→V2 deprecation path).
 *   2. Add supporting indexes for the queryable new columns
 *      (actor identity, target identity, mfaVerified analytics).
 *   3. Triggers (immutability + legalHold) are unaffected — they
 *      operate on row-level events, not column-level.
 *
 * # Why nullable
 *
 * Existing audit rows pre-date this shape. Forcing NOT NULL would
 * either require a backfill of fabricated values (data lie) or fail
 * boot on the first ALTER. Nullable + follow-up backfill migration
 * is the blue-green safe path. The audit-trail-completeness-auditor
 * agent's invariant accepts nullable for legacy rows during the
 * V1→V2 transition window.
 *
 * # Why secondary indexes
 *
 *   - (actorHomeTenantId, createdAt DESC) — forensic timeline of
 *     a SUPER_ADMIN's actions across tenants
 *   - (actedOnTenantId, createdAt DESC) — forensic timeline of
 *     actions taken against a specific target tenant
 *   - (mfaVerified, createdAt DESC) WHERE mfaVerified=true — fast
 *     filter for SOC 2 CC6.1 step-up evidence reports (partial
 *     index keeps it small — most rows are mfaVerified=false)
 *
 * # Why CONCURRENTLY for the indexes
 *
 * shared.audit_logs is a high-write live table. Non-CONCURRENTLY
 * CREATE INDEX would take AccessExclusive and stall every audit
 * write — which would propagate as 5xx upstream because audit
 * recording is on the synchronous request path. The migration
 * declares `transaction = 'none'` because CONCURRENTLY cannot run
 * inside a transaction block.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-CRITICAL-004
 */
export class AddAuditLogShapeExtension1788100000000
  implements MigrationInterface
{
  name = 'AddAuditLogShapeExtension1788100000000';

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
  transaction: 'none' = 'none';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: ADD COLUMN for each of the 8 mandatory fields. Each is
    // nullable so existing rows don't need a backfill before this
    // migration runs (blue-green safe).
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        ADD COLUMN IF NOT EXISTS "actorHomeTenantId" uuid,
        ADD COLUMN IF NOT EXISTS "actedOnTenantId"   uuid,
        ADD COLUMN IF NOT EXISTS "method"            varchar(16),
        ADD COLUMN IF NOT EXISTS "mfaVerified"       boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "result"            varchar(16),
        ADD COLUMN IF NOT EXISTS "preStateHash"      varchar(64),
        ADD COLUMN IF NOT EXISTS "postStateHash"     varchar(64),
        ADD COLUMN IF NOT EXISTS "justification"     text,
        ADD COLUMN IF NOT EXISTS "relatedAuditIds"   uuid[]
    `);

    // Step 2: CHECK constraints on the closed-vocabulary fields so
    // bad values can't slip in via raw SQL or future ORM regressions.
    //
    // method ∈ {HTTP, GRAPHQL, NATS, CRON, CLI}
    // result ∈ {SUCCESS, DENIED, FAILED}
    //
    // CHECK constraints are NOT validated against existing rows by
    // default (NOT VALID would skip even the new-row check). We use
    // the inline form so new rows are validated, and existing rows
    // are exempt because they're nullable.
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        ADD CONSTRAINT chk_audit_logs_method
        CHECK ("method" IS NULL OR "method" IN ('HTTP','GRAPHQL','NATS','CRON','CLI'))
    `).catch(() => { /* idempotent — constraint already added */ });
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        ADD CONSTRAINT chk_audit_logs_result
        CHECK ("result" IS NULL OR "result" IN ('SUCCESS','DENIED','FAILED'))
    `).catch(() => { /* idempotent */ });

    // Step 3: forensic indexes on the new actor/target identity
    // columns. CONCURRENTLY because shared.audit_logs is a live-
    // writer table.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_actor_home_tenant_created
        ON shared.audit_logs ("actorHomeTenantId", "createdAt" DESC)
        WHERE "actorHomeTenantId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_acted_on_tenant_created
        ON shared.audit_logs ("actedOnTenantId", "createdAt" DESC)
        WHERE "actedOnTenantId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_mfa_verified_created
        ON shared.audit_logs ("createdAt" DESC)
        WHERE "mfaVerified" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WHY: Removing the audit shape extension drops forensic
    // capability the audit-trail-completeness-auditor invariant
    // depends on. Down() reverts cleanly but operators using it
    // should be aware that SOC 2 CC1 cross-tenant access
    // reconstruction loses fidelity post-down.
    await queryRunner.query(`DROP INDEX IF EXISTS shared.idx_audit_logs_mfa_verified_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS shared.idx_audit_logs_acted_on_tenant_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS shared.idx_audit_logs_actor_home_tenant_created`);
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        DROP CONSTRAINT IF EXISTS chk_audit_logs_result,
        DROP CONSTRAINT IF EXISTS chk_audit_logs_method,
        DROP COLUMN IF EXISTS "relatedAuditIds",
        DROP COLUMN IF EXISTS "justification",
        DROP COLUMN IF EXISTS "postStateHash",
        DROP COLUMN IF EXISTS "preStateHash",
        DROP COLUMN IF EXISTS "result",
        DROP COLUMN IF EXISTS "mfaVerified",
        DROP COLUMN IF EXISTS "method",
        DROP COLUMN IF EXISTS "actedOnTenantId",
        DROP COLUMN IF EXISTS "actorHomeTenantId"
    `);
  }
}
