import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise plan Faz 3 — content-addressed deploy artifact store.
 *
 * Every deploy (SCADA package, process diagram, automation program)
 * snapshots the exact payload it shipped, keyed by the sha256 of its
 * canonical JSON. Identical content dedupes onto one row via the unique
 * (tenant_id, content_sha256) index; rows are append-only.
 *
 * Unqualified identifiers on purpose — db-migrate re-runs this per schema
 * (source `sensor` + every `tenant_*`) with `search_path` pinned.
 */
export class CreateDeployArtifacts1801300000000 implements MigrationInterface {
  name = 'CreateDeployArtifacts1801300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE deploy_artifacts_artifact_type_enum AS ENUM('scada_package', 'process', 'automation_program'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS deploy_artifacts (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        tenant_id uuid NOT NULL,
        artifact_type deploy_artifacts_artifact_type_enum NOT NULL,
        content_sha256 char(64) NOT NULL,
        content jsonb NOT NULL,
        schema_version integer,
        source_entity_id uuid,
        source_entity_version integer,
        created_by character varying,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT pk_deploy_artifacts PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_artifacts_tenant_sha ON deploy_artifacts (tenant_id, content_sha256)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_deploy_artifacts_tenant ON deploy_artifacts (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_deploy_artifacts_source ON deploy_artifacts (tenant_id, artifact_type, source_entity_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_deploy_artifacts_source`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_deploy_artifacts_tenant`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_deploy_artifacts_tenant_sha`);
    await queryRunner.query(`DROP TABLE IF EXISTS deploy_artifacts`);
    await queryRunner.query(`DROP TYPE IF EXISTS deploy_artifacts_artifact_type_enum`);
  }
}
