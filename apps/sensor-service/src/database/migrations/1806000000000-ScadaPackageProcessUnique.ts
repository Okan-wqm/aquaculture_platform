import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One SCADA package per process (SENSOR-HIGH-037).
 *
 * The unified editor adopts `linkedPackages[0]` for a process and creates
 * exactly one linked HMI package per process; earlier duplicate-process /
 * failed-then-retried saves could leave several packages sharing a
 * `process_id`, so reload adopted an arbitrary one and later saves orphaned
 * the rest. A partial unique index makes the 1:1 linkage structural.
 *
 * Dedup FIRST — a bare CREATE UNIQUE INDEX would fail on existing duplicate
 * rows. Keep the most-recently-updated package per (tenant_id, process_id)
 * and UNLINK the rest (process_id -> NULL); no package is deleted, the
 * orphaned ones simply become standalone (builder-style) packages.
 *
 * Unqualified identifiers on purpose — db-migrate re-runs this per schema
 * (source `sensor` + every `tenant_*`) with `search_path` pinned. All steps
 * are replay-idempotent (dedup is a no-op once unique; IF NOT EXISTS index).
 */
export class ScadaPackageProcessUnique1806000000000 implements MigrationInterface {
  name = 'ScadaPackageProcessUnique1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Unlink all but the newest package per (tenant_id, process_id).
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, process_id
                 ORDER BY updated_at DESC, id DESC
               ) AS rn
        FROM scada_packages
        WHERE process_id IS NOT NULL
      )
      UPDATE scada_packages sp
      SET process_id = NULL
      FROM ranked
      WHERE sp.id = ranked.id AND ranked.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_scada_packages_tenant_process
      ON scada_packages (tenant_id, process_id)
      WHERE process_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_scada_packages_tenant_process`);
  }
}
