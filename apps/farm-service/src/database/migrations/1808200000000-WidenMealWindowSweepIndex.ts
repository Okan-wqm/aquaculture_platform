import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WidenMealWindowSweepIndex (FARM-MEDIUM-271)
 *
 * The 15-minute meal-window sweep now re-notifies a meal that is still inside
 * its 60-minute lead window, instead of notifying it once for its lifetime. Its
 * supporting index still carried `"windowNotifiedAt" IS NULL` in the predicate,
 * so every re-notification candidate — precisely the rows the new query is for —
 * fell outside the index and the sweep degraded to a scan of the tenant's
 * scheduled meals every quarter hour.
 *
 * The predicate narrows to `status = 'scheduled'`, which is what the sweep
 * actually filters on; `windowNotifiedAt` moves into the indexed columns so the
 * "not notified since" comparison is still served by the index rather than by a
 * heap lookup per row.
 *
 * Index swap only — no data is touched. Created before the old one is dropped so
 * no window exists in which neither is available to the planner.
 *
 * Tenant-aware table: DDL is schema-unqualified; search_path routes each pass
 * into its own tenant schema.
 */
export class WidenMealWindowSweepIndex1808200000000 implements MigrationInterface {
  name = 'WidenMealWindowSweepIndex1808200000000';

  private static readonly OLD_INDEX = 'IDX_fm_window_pending';
  private static readonly NEW_INDEX = 'IDX_fm_window_sweep';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${WidenMealWindowSweepIndex1808200000000.NEW_INDEX}"
         ON "feeding_meals" ("tenantId", "scheduledAt", "windowNotifiedAt")
         WHERE "status" = 'scheduled'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${WidenMealWindowSweepIndex1808200000000.OLD_INDEX}"`,
    );
  }

  /** The sweep's index exists and the narrower one it replaces is gone. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = '${WidenMealWindowSweepIndex1808200000000.NEW_INDEX}'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = '${WidenMealWindowSweepIndex1808200000000.OLD_INDEX}'
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${WidenMealWindowSweepIndex1808200000000.OLD_INDEX}"
         ON "feeding_meals" ("tenantId", "scheduledAt")
         WHERE "status" = 'scheduled' AND "windowNotifiedAt" IS NULL`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${WidenMealWindowSweepIndex1808200000000.NEW_INDEX}"`,
    );
  }
}
