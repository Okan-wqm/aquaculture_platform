import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise plan Faz 5 — two-phase release bundles.
 *
 * One row per bundle shipped to one edge device. The manifest (jsonb)
 * pins each member artifact's content sha256; manifest_sha256 is the
 * ed25519-signed value; status walks the PENDING → STAGED → CONFIRMED
 * (→ ROLLED_BACK) / → FAILED machine enforced by ReleaseBundleService.
 *
 * Unqualified identifiers on purpose — db-migrate re-runs this per schema
 * (source `sensor` + every `tenant_*`) with `search_path` pinned.
 */
export class CreateReleaseBundles1801500000000 implements MigrationInterface {
  name = 'CreateReleaseBundles1801500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE release_bundles_status_enum AS ENUM('pending', 'staged', 'confirmed', 'failed', 'rolled_back'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS release_bundles (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        tenant_id uuid NOT NULL,
        device_id uuid NOT NULL,
        command_id uuid NOT NULL,
        manifest jsonb NOT NULL,
        manifest_sha256 char(64) NOT NULL,
        signature character varying(128),
        status release_bundles_status_enum NOT NULL DEFAULT 'pending',
        previous_bundle_id uuid,
        error_message text,
        staged_at TIMESTAMP WITH TIME ZONE,
        confirmed_at TIMESTAMP WITH TIME ZONE,
        failed_at TIMESTAMP WITH TIME ZONE,
        created_by character varying,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT pk_release_bundles PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_release_bundles_tenant_command ON release_bundles (tenant_id, command_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_release_bundles_tenant ON release_bundles (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_release_bundles_device_status ON release_bundles (tenant_id, device_id, status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_release_bundles_device_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_release_bundles_tenant`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_release_bundles_tenant_command`);
    await queryRunner.query(`DROP TABLE IF EXISTS release_bundles`);
    await queryRunner.query(`DROP TYPE IF EXISTS release_bundles_status_enum`);
  }
}
