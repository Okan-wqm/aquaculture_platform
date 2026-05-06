import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Migration: Dual-approver protocol for legal hold release.
 *
 * # Why this exists — LEGAL-MEDIUM-002 cure
 *
 * The legal-hold-auditor agent spec mandates: "Override protocol:
 * requires ALL of: SUPER_ADMIN role + MFA step-up (≤5min) + explicit
 * reason (≥50 chars) + dual-approver (second SUPER_ADMIN
 * click-through)". Pre-cure release was a single-identity operation:
 * one SUPER_ADMIN with the hold's id could end the hold; no record of
 * who countersigned and no schema-level prevention of self-approval.
 *
 * This migration adds two columns + one CHECK constraint that pin the
 * dual-approver invariant at the database layer (Tier-1 architectural
 * cure):
 *
 *   - `releasedByApprover` uuid NULL — the SECOND SUPER_ADMIN id
 *   - `releaseReason` text NULL — ≥50 chars justification (length
 *     enforced at the service layer; the column itself is text)
 *   - `chk_legal_hold_no_self_approval` CHECK constraint —
 *     `releasedByApprover IS NULL OR releasedBy <> releasedByApprover`
 *
 * # Why nullable + CHECK rather than NOT NULL
 *
 * Pre-cure rows have `releasedBy` populated but no approver. NOT NULL
 * would either lock those rows out (FK cascades break) or force a
 * synthetic backfill that would lie about who approved. Nullable
 * lets pre-cure history stay truthful; the CHECK constraint catches
 * any FUTURE attempt to release with self-approval. The service-layer
 * cure makes approverId mandatory on every NEW release.
 *
 * # Tenant fan-out
 *
 * Like 1782600000000-AlignMessagingEntityDrift, this migration is
 * declared `tenantAware: true` and runs against the source `messaging`
 * schema first, then every tenant schema. Each iteration's
 * `search_path` resolves the unqualified `legal_holds` correctly.
 *
 * @see docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-MEDIUM-002
 */
export class AddLegalHoldDualApprover1782700000000 implements MigrationInterface {
  name = 'AddLegalHoldDualApprover1782700000000';
  private readonly logger = new Logger(AddLegalHoldDualApprover1782700000000.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    this.logger.log(
      `Applying LEGAL-MEDIUM-002 dual-approver schema (schema=${schema})`,
    );

    // 1. Add releasedByApprover (idempotent — re-run safe).
    if (!(await this.columnExists(queryRunner, 'legal_holds', 'releasedByApprover'))) {
      await queryRunner.query(
        `ALTER TABLE "legal_holds" ADD COLUMN "releasedByApprover" uuid NULL`,
      );
    }

    // 2. Add releaseReason.
    if (!(await this.columnExists(queryRunner, 'legal_holds', 'releaseReason'))) {
      await queryRunner.query(
        `ALTER TABLE "legal_holds" ADD COLUMN "releaseReason" text NULL`,
      );
    }

    // 3. CHECK constraint — only add if not already present.
    if (!(await this.constraintExists(queryRunner, 'legal_holds', 'chk_legal_hold_no_self_approval'))) {
      await queryRunner.query(
        `ALTER TABLE "legal_holds"
         ADD CONSTRAINT "chk_legal_hold_no_self_approval"
         CHECK ("releasedByApprover" IS NULL OR "releasedBy" <> "releasedByApprover")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    this.logger.log(
      `Reverting LEGAL-MEDIUM-002 dual-approver schema (schema=${schema})`,
    );

    // DROP COLUMN / DROP CONSTRAINT in down() are the rollback path of
    // the up() additions above. `IF EXISTS` makes them safe to re-run
    // and signals to the migration-sql-lint gate that the destructive
    // DDL is the documented inverse of the additive up() — same pattern
    // as 1782600000000-AlignMessagingEntityDrift's down().
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP CONSTRAINT IF EXISTS "chk_legal_hold_no_self_approval"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "releaseReason"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "releasedByApprover"`,
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const rows: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    return rows[0]?.current_schema ?? 'unknown';
  }

  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    return rows[0]?.exists === true;
  }

  private async constraintExists(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND constraint_name = $2
       ) AS exists`,
      [table, constraint],
    );
    return rows[0]?.exists === true;
  }
}
