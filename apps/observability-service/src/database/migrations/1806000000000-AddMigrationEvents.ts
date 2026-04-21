import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddMigrationEvents1806000000000
 * ============================================================================
 *
 * Phase 0 of the db-migrate enterprise refactor (docs/plans/2026-04-21-
 * db-migrate-enterprise-refactor.md §R17). Adds
 * `observability.migration_events` — the durable audit trail for every
 * db-migrate lifecycle event + drift-validator emission across the
 * platform.
 *
 * # Retention
 *
 * 13 months (SOC2 CC4.1 12mo + 1mo buffer per ADR-024). Retention is
 * enforced by a scheduled job (not by this migration). The table has a
 * partial index on recent rows to keep the hot-path query plan selective.
 *
 * # PII safety
 *
 * - `tenant_id_hash` is HMAC-pseudonymised at emit time (libs/backend-
 *   common/src/utils/hmac-tenant-hash.util.ts). The DB never sees the
 *   cleartext schema name.
 * - `error_detail` JSONB passes through sanitizePgError() before persist.
 *   CI invariant (R25) rejects row-leak patterns.
 * - No free-form message columns — all operator-facing text lives under
 *   `error_detail.message` with the sanitizer contract.
 *
 * # RLS
 *
 * NOT RLS-enabled — this is a platform-ops audit surface read across
 * tenants by design. Tenant-scoped queries filter on the HMAC hash
 * computed via the per-env pepper (GDPR Art 17 cascade-safe).
 */
export class AddMigrationEvents1806000000000 implements MigrationInterface {
  name = 'AddMigrationEvents1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'migration_event_type_enum'
            AND n.nspname = 'observability'
        ) THEN
          CREATE TYPE observability.migration_event_type_enum AS ENUM (
            'start', 'applied', 'failed', 'skipped',
            'validator_clean', 'validator_warn', 'validator_error'
          );
        END IF;
      END $$;
    `);

    // Initial-schema CREATE TABLE + indexes in one chunk. The migration-
    // SQL linter grandfathers plain CREATE INDEX (non-CONCURRENTLY) here
    // because the table is empty at index-creation time — no writer
    // stall is possible. See rule R3-create-index-not-concurrent
    // exemption in tools/gates/migration-sql-lint.ts.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS observability.migration_events (
        id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL,
        service_name VARCHAR(64) NOT NULL,
        migration_name VARCHAR(256) NOT NULL,
        event_type observability.migration_event_type_enum NOT NULL,
        tenant_id_hash VARCHAR(128) NULL,
        drift_class_id VARCHAR(64) NULL,
        duration_ms INTEGER NULL,
        error_detail JSONB NULL,
        environment VARCHAR(32) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "IDX_migration_events_service_env_time"
        ON observability.migration_events (service_name, environment, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS "IDX_migration_events_migration_time"
        ON observability.migration_events (migration_name, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS "IDX_migration_events_tenant_hash_drift_time"
        ON observability.migration_events (tenant_id_hash, drift_class_id, occurred_at DESC)
        WHERE tenant_id_hash IS NOT NULL;
    `);

    await queryRunner.query(
      `COMMENT ON TABLE observability.migration_events IS 'db-migrate lifecycle + drift validator audit trail. 13-month retention (ADR-024). PII-safe: tenant_id_hash is HMAC-pseudonymised (ADR-022); error_detail passes sanitizePgError() before persist (plan v3 R25).'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting drops the audit trail — unsafe for SOC2 evidence. Keep
    // the table; down() is a no-op on platform-ops surfaces per the
    // pattern used by AddTenantCostRollup. Operators who truly need to
    // drop it must do so manually + archive the data.
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );
    // No-op: see docblock.
  }
}
