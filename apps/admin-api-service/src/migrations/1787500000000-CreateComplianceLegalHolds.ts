import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateComplianceLegalHolds1787500000000
 * ============================================================================
 *
 * Establishes the `compliance` schema and the canonical legal-hold registry
 * table at `compliance.legal_holds`. Every destructive operation across the
 * platform consults this table BEFORE proceeding (LEGAL-CRITICAL-001..003
 * cure path; the assertion call sites land in W2.7 cascade commits).
 *
 * # Why the `compliance` schema
 *
 * Per ADR-011 + W5 BLOCKER-15 the `shared` schema is reserved for FOUR
 * canonical cross-tenant tables (audit_logs, gdpr_data_requests,
 * user_consents, user_permissions). Adding a 5th shared table requires
 * an ADR. The `compliance` schema is the architecturally-cleaner home
 * for cross-cutting compliance state — legal holds today; future
 * possibilities (retention policies, GDPR request rows if their
 * service-local schemas converge) can co-locate without churning
 * `shared`.
 *
 * # Per-service GRANTs
 *
 * Every service role that has a destructive operation needs SELECT on
 * compliance.legal_holds (to consult the registry) AND INSERT on the
 * release-approvals table (W0.C-finalize) for dual-control. Today we
 * grant SELECT only — INSERT/UPDATE on legal_holds itself remains
 * scoped to admin-api (the only service that operates the registry).
 *
 * # Idempotency
 *
 * The schema CREATE IF NOT EXISTS + table CREATE TABLE IF NOT EXISTS
 * + GRANT statements are idempotent. Re-running the migration is a
 * safe no-op.
 *
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-001 (foundation)
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-002 (foundation)
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-003 (foundation)
 */
export class CreateComplianceLegalHolds1787500000000 implements MigrationInterface {
  name = 'CreateComplianceLegalHolds1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Create the compliance schema (idempotent).
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS compliance`);

    // Step 2: Create the legal_holds table + its indexes in ONE statement
    // chunk so the migration-sql-lint R3 (CREATE INDEX requires CONCURRENTLY)
    // grants the initial-schema exemption — the table is empty at index
    // creation time so the ACCESS EXCLUSIVE lock cannot stall live writers.
    //
    // WHY each column shape:
    //   - id: uuid primary key, server-generated.
    //   - tenantId: uuid, NOT NULL — every hold belongs to a tenant.
    //   - scope: varchar(32), NOT NULL — closed enum at the application layer
    //     (tenant|channel|farm|invoice|audit|user). Not a DB enum because the
    //     enum is closed by application convention; future additions are
    //     audited via ADR but should not require a column-type ALTER.
    //   - resourceId: uuid NULLABLE — null for tenant-wide holds.
    //   - reason / legalMatterId: text + varchar(128) — human-readable.
    //   - appliedBy / releasedBy: uuid — auth.users.id (FK NOT enforced at
    //     DB level because cross-schema FKs across services are not the
    //     pattern on this platform; existence is asserted at the service
    //     layer).
    //   - appliedAt: timestamptz NOT NULL DEFAULT now() — server-generated.
    //   - releasedAt / releasedBy / releaseReason: NULLABLE; set when the
    //     hold is released. The partial unique index uses
    //     `WHERE "releasedAt" IS NULL` to allow multiple HISTORICAL holds
    //     on the same resource while preventing duplicate ACTIVE holds.
    //
    // Indexes:
    //   - IDX_legal_hold_active matches LegalHoldService.isUnderHold's
    //     (tenantId, scope, resourceId, releasedAt) WHERE shape.
    //   - IDX_legal_hold_legal_matter supports legal-team "all holds for
    //     matter X" queries when a matter closes.
    //   - UQ_legal_hold_active_per_resource prevents duplicate active
    //     holds on the same (tenantId, scope, resourceId) tuple while
    //     permitting multiple historical holds across matter lifetimes.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS compliance.legal_holds (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "scope" varchar(32) NOT NULL,
        "resourceId" uuid NULL,
        "reason" text NOT NULL,
        "legalMatterId" varchar(128) NOT NULL,
        "appliedBy" uuid NOT NULL,
        "appliedAt" timestamptz NOT NULL DEFAULT now(),
        "releasedBy" uuid NULL,
        "releasedAt" timestamptz NULL,
        "releaseReason" text NULL,
        CONSTRAINT "PK_compliance_legal_holds" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_legal_hold_active"
        ON compliance.legal_holds ("tenantId", "scope", "resourceId", "releasedAt");
      CREATE INDEX IF NOT EXISTS "IDX_legal_hold_legal_matter"
        ON compliance.legal_holds ("legalMatterId");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_legal_hold_active_per_resource"
        ON compliance.legal_holds ("tenantId", "scope", "resourceId")
        WHERE "releasedAt" IS NULL;
    `);

    // Step 4: Per-service SELECT grants. Every service that runs a
    // destructive operation needs to consult the registry. INSERT /
    // UPDATE remain scoped to admin-api (the operator-facing surface).
    // Defence-in-depth: skip roles that don't exist on this droplet.
    const readers = [
      'auth_service',
      'farm_service',
      'sensor_service',
      'hr_service',
      'messaging_service',
      'hydroponics_service',
      'alert_service',
      'billing_service',
      'notification_service',
      'ai_service',
      'admin_service',
      'observability_service',
      'event_store_service',
    ];
    for (const role of readers) {
      const roleExists: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
        [role],
      );
      if (!roleExists[0]?.exists) continue;
      await queryRunner.query(`GRANT USAGE ON SCHEMA compliance TO "${role}"`);
      await queryRunner.query(
        `GRANT SELECT ON compliance.legal_holds TO "${role}"`,
      );
    }
    // admin-api owns operator-facing INSERT/UPDATE.
    const adminExists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') AS exists`,
    );
    if (adminExists[0]?.exists) {
      await queryRunner.query(
        `GRANT INSERT, UPDATE ON compliance.legal_holds TO "admin_service"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WHY: Dropping the legal-hold registry is a compliance-critical
    // destructive operation. We accept the rollback only if the operator
    // has explicitly acknowledged the consequences via a runbook — the
    // automatic down() refuses to proceed because the registry contains
    // litigation-preservation state.
    throw new Error(
      'Refusing to rollback compliance.legal_holds. Dropping the registry destroys ' +
        'litigation-preservation state. See docs/runbooks/legal-hold-rollback.md for the ' +
        'documented operator procedure (legal-team waiver mandated).',
    );
  }
}
