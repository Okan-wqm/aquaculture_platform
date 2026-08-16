import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Makes the reproducible meal-window contract index-backed for every re-emission. */
export class WidenMealWindowReemissionIndex1809300000000 implements MigrationInterface {
  name = 'WidenMealWindowReemissionIndex1809300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    const presence: Array<{ meals: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_meals')::text AS meals`,
    );
    if (!presence[0]?.meals) return;

    // Create the wider index before retiring the one-shot predicate so the
    // scheduled reader never has an uncovered deployment window.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_fm_window_sweep"
        ON "feeding_meals" ("tenantId", "scheduledAt", "windowNotifiedAt")
        WHERE status = 'scheduled'
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fm_window_pending"`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT to_regclass('feeding_meals') IS NULL OR (
        to_regclass('"IDX_fm_window_sweep"') IS NOT NULL
        AND to_regclass('"IDX_fm_window_pending"') IS NULL
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: restoring the one-shot predicate would make reproducible
    // event delivery depend on a heap scan or silently lose re-emissions.
  }
}
