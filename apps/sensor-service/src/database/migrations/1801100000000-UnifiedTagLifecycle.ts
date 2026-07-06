import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tag SSoT Faz 1 — lifecycle columns on the tag registry.
 *
 * `unified_tags` is promoted from a passive discovery cache to the
 * authoritative tag registry (enterprise plan, Faz 1). Consumers resolving
 * TagRefs need lifecycle state (`status`) so retired tags stop resolving
 * without row deletion (deploy artifacts may still reference them), and a
 * `revision` counter so binding snapshots can record which registry revision
 * they were resolved against.
 *
 * Table names are deliberately UNQUALIFIED: db-migrate re-runs this file per
 * schema with `search_path` pinned (source `sensor` + every `tenant_*`), so
 * the same DDL lands in each schema's own `unified_tags`.
 *
 * Blue-green: ADD COLUMN ... NOT NULL DEFAULT is non-rewriting on PG11+ and
 * old writers are unaffected (defaults fill the new columns).
 */
export class UnifiedTagLifecycle1801100000000 implements MigrationInterface {
  name = 'UnifiedTagLifecycle1801100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE unified_tags_status_enum AS ENUM('draft', 'active', 'retired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await queryRunner.query(
      `ALTER TABLE unified_tags ADD COLUMN IF NOT EXISTS status unified_tags_status_enum NOT NULL DEFAULT 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE unified_tags ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_unified_tags_tenant_status ON unified_tags (tenant_id, status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_unified_tags_tenant_status`);
    await queryRunner.query(`ALTER TABLE unified_tags DROP COLUMN IF EXISTS revision`);
    await queryRunner.query(`ALTER TABLE unified_tags DROP COLUMN IF EXISTS status`);
    await queryRunner.query(`DROP TYPE IF EXISTS unified_tags_status_enum`);
  }
}
