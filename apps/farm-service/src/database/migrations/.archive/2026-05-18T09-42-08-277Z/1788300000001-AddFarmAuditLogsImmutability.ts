import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddFarmAuditLogsImmutability1788300000001
 * ============================================================================
 *
 * Installs database-level immutability triggers + the `legalHold`
 * boolean column on `farm.farm_audit_logs`. Mirrors the canonical
 * trigger set established for `shared.audit_logs` (admin-api migration
 * 1787400000000-RestoreSharedAuditLogsImmutability) and `auth.audit_logs`
 * (auth-service migration 1787100000000-AddAuthAuditLogsImmutability).
 *
 * # Why this migration exists
 *
 * Pre-fix `farm.farm_audit_logs` was mutable at the DB level. The audit-row
 * stream covers every farm-domain mutation: pond/batch CREATE, water-quality
 * UPDATE, harvest DELETE, feeding-execution adjust, supplier-onboarding,
 * regulatory-settings change. AUDITTRAIL-HIGH-005 captured the gap: the W0.D
 * cure restored protections for `shared.audit_logs`, the auth-side mirror
 * shipped in auth migration 1787100000000, but the farm-side per-tenant audit
 * table was left unprotected — leaving the farm-domain trail freely
 * UPDATE-able and DELETE-able by any application role with table privileges.
 *
 * # What this migration does
 *
 *   1. ADD COLUMN `legalHold boolean NOT NULL DEFAULT false` on
 *      `farm.farm_audit_logs` (idempotent).
 *   2. CREATE OR REPLACE the two trigger functions in `farm` schema —
 *      function bodies match the canonical originals so behaviour is
 *      identical across every audit table in the platform.
 *   3. DROP+CREATE the two triggers on `farm.farm_audit_logs` (idempotent
 *      via DROP TRIGGER IF EXISTS guard).
 *
 * # Compliance frameworks served
 *
 *   - SOX § 404 (auditable internal controls)
 *   - PCI-DSS § 10.5 (secure audit trails)
 *   - SOC 2 CC4 (control monitoring + audit-trail tamper-evidence)
 *   - GDPR Art 30 (record-of-processing integrity)
 *
 * # Down-rollback
 *
 * Rollback is REFUSED — same rationale as the shared- and auth-schema
 * migrations. Removing audit-row immutability violates four compliance
 * frameworks simultaneously; operators with a genuine need follow the
 * documented runbook with legal-team waiver.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-HIGH-005
 */
export class AddFarmAuditLogsImmutability1788300000001
  implements MigrationInterface
{
  name = 'AddFarmAuditLogsImmutability1788300000001';

  private readonly logger = new MigrationLogger(
    'AddFarmAuditLogsImmutability1788300000001',
  );

  /**
   * Wave 4-A.2 Dalga 3 bootstrap-restoration guard.
   *
   * `farm.farm_audit_logs` is produced by the source-schema baseline.
   * The hardcoded `farm.` schema prefix used by the trigger DDL below
   * bypasses search_path pinning, so we look up the table in
   * `information_schema.tables` with an explicit schema filter rather
   * than the `current_schema()` helper.
   */
  private async hasFarmAuditLogs(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'farm'
          AND table_name = 'farm_audit_logs'
      ) AS exists
    `);
    return rows[0]?.exists === true;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasFarmAuditLogs(queryRunner))) {
      this.logger.log(
        'Skipping AddFarmAuditLogsImmutability — farm.farm_audit_logs not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    // Step 1: Add the legalHold column. NOT NULL with same-clause DEFAULT
    // is blue-green safe (migration-sql-lint R2 compliant) — Postgres 11+
    // metadata-only ALTER, no table rewrite.
    //
    // WHY: The BEFORE DELETE trigger inspects `OLD."legalHold"` and refuses
    // deletion when the flag is true. Mirrors the canonical pattern so a
    // litigation-hold flag set on any tenant's farm-domain audit row is
    // honoured by the same DB-level guarantee.
    await queryRunner.query(`
      ALTER TABLE farm.farm_audit_logs
      ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
    `);

    // Step 2a: prevent_update function (mirrors shared.audit_logs canonical).
    //
    // WHY: Audit rows are append-only by design. RAISE EXCEPTION on every
    // UPDATE prevents both buggy application code AND attackers with direct
    // DB credentials from rewriting history. Function lives in `farm`
    // schema so it is invoked even when the calling session has a different
    // search_path.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.farm_audit_logs_prevent_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'farm.farm_audit_logs rows are immutable - UPDATE is not permitted';
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 2b: prevent_update trigger.
    //
    // WHY: A function alone does nothing; the trigger object binds the
    // function to a table+event. BEFORE UPDATE fires before any row
    // modification commits, so the RAISE inside the function aborts the
    // entire statement transactionally — no half-applied mutation possible.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_farm_audit_logs_prevent_update ON farm.farm_audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_farm_audit_logs_prevent_update
      BEFORE UPDATE ON farm.farm_audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION farm.farm_audit_logs_prevent_update()
    `);

    // Step 3a: prevent_legal_hold_delete function.
    //
    // WHY: Litigation hold imposes a legal duty to preserve evidence.
    // Even an authorised operator running the 90-day retention sweep must
    // not be able to delete rows flagged for hold. Database-level
    // enforcement means a buggy retention cron, a misconfigured CASCADE,
    // or any other accidental DELETE simply errors out instead of silently
    // destroying evidence — defense-in-depth against compromised
    // application credentials AND code regressions.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.farm_audit_logs_prevent_legal_hold_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD."legalHold" = true THEN
          RAISE EXCEPTION 'Cannot delete farm.farm_audit_logs row with active legal hold (id=%)', OLD.id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 3b: prevent_legal_hold_delete trigger.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_farm_audit_logs_prevent_legal_hold_delete ON farm.farm_audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_farm_audit_logs_prevent_legal_hold_delete
      BEFORE DELETE ON farm.farm_audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION farm.farm_audit_logs_prevent_legal_hold_delete()
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // WHY: Removing audit-row immutability violates SOX § 404 + PCI-DSS § 10.5
    // + SOC 2 CC4 + GDPR Art 30 simultaneously. A "convenient" rollback is
    // forbidden — the cost of weak audit posture is paid forever.
    throw new Error(
      'Refusing to rollback farm.farm_audit_logs immutability. ' +
        'Removing audit immutability or the legalHold column violates ' +
        'SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30 ' +
        'tamper-evidence requirements. See ' +
        'docs/runbooks/audit-immutability-rollback.md for the documented ' +
        'operator procedure (legal-team waiver mandated).',
    );
  }
}
