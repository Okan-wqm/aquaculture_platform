import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ReclassifyTechnicalLeads — corrective backfill for HR-LOW-001.
 *
 * The original `AddEmployeeLaborCategory` (1801600000000) auto-map ran the
 * MANAGER pattern (`…|lead|chief|…`) BEFORE the TECHNICAL pattern, and each
 * pass only touched still-NULL rows. Because `~*` is an unanchored substring
 * match, any technical craft role whose title contains `lead` or `chief`
 * ("Lead Technician", "Lead Biologist", "Chief Engineer" — a licensed senior
 * *technical* role) was locked to `manager`, skewing the labour-cost analytics
 * (inflated MANAGER headcount/salary, deflated TECHNICAL). No payroll/tax
 * effect — the labour-category is analytics-only.
 *
 * Correct ordering principle (for any FUTURE backfill): a SPECIFIC craft
 * signal (technician/biolog/engineer/…) must outrank the GENERIC seniority
 * tokens `lead`/`chief`, which are not by themselves management.
 *
 * This migration cannot re-order the already-applied historical passes, so it
 * corrects the data conservatively: reclassify a row to `technical` ONLY when
 * it is currently `manager`, its position matches an UNAMBIGUOUS craft noun,
 * it contains `lead`/`chief` (the exact misclassification vector), it matches
 * NO genuine management token, and its department is not `management`. That
 * intersection is precisely the "Lead Technician / Chief Engineer" set the
 * ambiguous token mislabelled — a deliberately hand-set manager-with-craft-
 * title (rare) is left untouched only if it carries a real management token or
 * the management department; otherwise it is re-corrected toward the accurate
 * craft classification, which the product already treats as form-editable.
 *
 * Idempotent: after the update those rows are `technical`, so a replay matches
 * nothing. Forward-only; `down()` is a deliberate no-op (re-applying the
 * original bug is not a rollback we want).
 */
export class ReclassifyTechnicalLeads1802000000000 implements MigrationInterface {
  name = 'ReclassifyTechnicalLeads1802000000000';

  /** Rows still mislabelled `manager` purely by the `lead`/`chief` token. */
  private readonly misclassifiedPredicate = `
    "laborCategory" = 'manager'
    AND "department" != 'management'
    AND "position" ~* '(lead|chief)'
    AND "position" ~* '(technician|technical|biolog|engineer|veterinar|water.?quality|tekniker|teknisyen|mühendis|veteriner)'
    AND "position" !~* '(manager|director|supervisor|head of|yönetici|müdür|şef)'
  `;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "employees"
      SET "laborCategory" = 'technical'
      WHERE ${this.misclassifiedPredicate}
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // No craft-with-lead/chief row should remain mislabelled `manager`.
    const rows = (await queryRunner.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM "employees" WHERE ${this.misclassifiedPredicate}
      ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: reverting would re-introduce the HR-LOW-001 misclassification.
  }
}
