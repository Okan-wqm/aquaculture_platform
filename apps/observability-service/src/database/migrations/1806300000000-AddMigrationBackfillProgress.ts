import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddMigrationBackfillProgress1806300000000
 * ============================================================================
 *
 * R6 runtime gate foundation — creates
 * `observability.migration_backfill_progress`, the durable truth for
 * "has migration X been applied in environment Y?" that contract-phase
 * @ExpandContract migrations consult at runtime.
 *
 * # Composite PK
 *
 * (migration_name, environment). Same migration applied to staging +
 * production gets two rows. UPSERT (ON CONFLICT DO NOTHING) at the
 * write path preserves the original apply timestamp.
 *
 * # Retention
 *
 * 7 years (SOC2 CC8.1) registered alongside schema_object_history in
 * RetentionBootstrapModule. Long enough that any contract-phase
 * dependsOn can resolve.
 *
 * # down()
 *
 * No-op — dropping the table would invalidate every contract-phase
 * migration's runtime gate. Operators must rebuild by replaying
 * every service's apply events through RecordMigrationEventHandler
 * with ON CONFLICT DO NOTHING.
 */
export class AddMigrationBackfillProgress1806300000000
  implements MigrationInterface
{
  name = 'AddMigrationBackfillProgress1806300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS observability.migration_backfill_progress (
        migration_name VARCHAR(256) NOT NULL,
        environment VARCHAR(32) NOT NULL,
        service_name VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (migration_name, environment)
      );

      CREATE INDEX IF NOT EXISTS "IDX_migration_backfill_progress_service_env"
        ON observability.migration_backfill_progress
        (service_name, environment, applied_at DESC);
    `);
    await queryRunner.query(
      `COMMENT ON TABLE observability.migration_backfill_progress IS 'Durable "has this migration applied?" truth consulted by @ExpandContract contract-phase runtime gate. 7-year retention (ADR-024). ON CONFLICT DO NOTHING upsert preserves first-apply timestamp.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );
    // No-op: removing this table would break every contract-phase
    // migration's runtime gate. See docblock.
  }
}
