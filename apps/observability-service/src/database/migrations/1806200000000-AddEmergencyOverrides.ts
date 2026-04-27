import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddEmergencyOverrides1806200000000
 * ============================================================================
 *
 * Phase 4.5 + R16 of the db-migrate enterprise refactor. Adds
 * `observability.emergency_overrides` — the durable audit trail for
 * operator-issued operational bypasses (drift-fatal bypass, migration
 * skip, validator disable). Replaces the plan v2 "ssh + vi .env"
 * pattern with a time-bounded, attributable record.
 *
 * # Retention
 *
 * 7 years per ADR-024 (SOC2 CC6.1 access-control evidence). Enforced
 * by a separate scheduled job (follow-up task).
 *
 * # down()
 *
 * No-op — removing the audit log is unsafe for SOC2 review.
 */
export class AddEmergencyOverrides1806200000000 implements MigrationInterface {
  name = 'AddEmergencyOverrides1806200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'emergency_override_kind_enum'
            AND n.nspname = 'observability'
        ) THEN
          CREATE TYPE observability.emergency_override_kind_enum AS ENUM (
            'drift_fatal_bypass', 'migration_skip', 'validator_disable'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS observability.emergency_overrides (
        id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        service_name VARCHAR(64) NOT NULL,
        kind observability.emergency_override_kind_enum NOT NULL,
        reason TEXT NOT NULL,
        actor VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        environment VARCHAR(32) NOT NULL,
        revoked_reason TEXT NULL,
        revoked_at TIMESTAMPTZ NULL,
        CONSTRAINT emergency_overrides_expiry_future
          CHECK (expires_at > created_at)
      );

      CREATE INDEX IF NOT EXISTS "IDX_emergency_overrides_service_active"
        ON observability.emergency_overrides (service_name, expires_at);

      CREATE INDEX IF NOT EXISTS "IDX_emergency_overrides_actor"
        ON observability.emergency_overrides (actor, created_at);
    `);

    await queryRunner.query(
      `COMMENT ON TABLE observability.emergency_overrides IS 'Operator-issued operational bypasses (drift-fatal, migration skip, validator disable). 7-year retention (ADR-024). aqua-ctl writes rows; validator + runner consult table to suppress (Phase 4.5/R16 + follow-up integration).'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );
    // No-op — see docblock.
  }
}
