import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddSchemaObjectHistory1806100000000
 * ============================================================================
 *
 * Phase 0 of the db-migrate enterprise refactor (plan v3 §R17). Adds
 * `observability.schema_object_history` — the SOC2 CC8.1 change-management
 * audit trail that records every DDL mutation across every schema.
 *
 * # Retention
 *
 * 7 years per ADR-024. Enforced by a scheduled retention job (Phase 9),
 * not by this migration.
 *
 * # down()
 *
 * No-op — dropping the SOC2 evidence table destroys the audit chain.
 * Operators who need to truly drop it must archive the data first and
 * issue the DROP manually outside the migration pipeline.
 */
export class AddSchemaObjectHistory1806100000000 implements MigrationInterface {
  name = 'AddSchemaObjectHistory1806100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'schema_object_type_enum'
            AND n.nspname = 'observability'
        ) THEN
          CREATE TYPE observability.schema_object_type_enum AS ENUM (
            'table', 'column', 'index', 'constraint', 'enum', 'policy'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'schema_object_action_enum'
            AND n.nspname = 'observability'
        ) THEN
          CREATE TYPE observability.schema_object_action_enum AS ENUM (
            'created', 'altered', 'dropped', 'renamed'
          );
        END IF;
      END $$;
    `);

    // Initial-schema chunk (CREATE TABLE + CREATE INDEX grandfathered —
    // table empty at index-creation time; linter R3 exemption).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS observability.schema_object_history (
        id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL,
        schema_name VARCHAR(64) NOT NULL,
        object_type observability.schema_object_type_enum NOT NULL,
        object_name VARCHAR(256) NOT NULL,
        action observability.schema_object_action_enum NOT NULL,
        schema_snapshot_hash VARCHAR(64) NULL,
        actor VARCHAR(256) NOT NULL,
        detail JSONB NULL,
        environment VARCHAR(32) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "IDX_schema_object_history_schema_object_time"
        ON observability.schema_object_history
        (schema_name, object_type, object_name, observed_at DESC);

      CREATE INDEX IF NOT EXISTS "IDX_schema_object_history_actor_time"
        ON observability.schema_object_history (actor, observed_at DESC);
    `);

    await queryRunner.query(
      `COMMENT ON TABLE observability.schema_object_history IS 'SOC2 CC8.1 change-management audit. 7-year retention (ADR-024). Emitted by db-migrate orchestrator per DDL statement + boot-time reconciler for unattributed drift.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT set_config('search_path', 'observability,public', true)`,
    );
    // No-op — see docblock.
  }
}
