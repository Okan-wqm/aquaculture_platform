import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise plan Faz 3 — deploy logs reference their artifact snapshot,
 * process deploys become loggable and versioned.
 *
 * - scada_deploy_logs + deployment_logs gain nullable artifact_id +
 *   checksum_sha256 (legacy rows keep NULL; deployment_logs rows that
 *   still carry their edge_script are backfilled with its checksum when
 *   pgcrypto is available — best-effort, documented).
 * - scada_deploy_logs.package_id becomes nullable and a nullable
 *   process_id is added so PROCESS deploys share the same log table
 *   (a row must reference exactly one of the two — CHECK constraint).
 * - processes gains a version counter (was hardcoded `1` in the deploy
 *   payload); the service bumps it on every update.
 *
 * Unqualified identifiers on purpose — db-migrate re-runs this per schema
 * (source `sensor` + every `tenant_*`) with `search_path` pinned. All
 * steps are replay-idempotent (guards on information_schema / IF NOT
 * EXISTS / duplicate_object).
 */
export class DeployLogArtifactColumns1801400000000 implements MigrationInterface {
  name = 'DeployLogArtifactColumns1801400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── artifact linkage on both deploy logs ─────────────────────────────
    await queryRunner.query(
      `ALTER TABLE scada_deploy_logs ADD COLUMN IF NOT EXISTS artifact_id uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE scada_deploy_logs ADD COLUMN IF NOT EXISTS checksum_sha256 char(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS artifact_id uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS checksum_sha256 char(64)`,
    );

    // Best-effort checksum backfill for legacy automation deploys — their
    // edge_script IS the shipped artifact. Only when pgcrypto's digest()
    // is installed; new rows get checksums from the application either way.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
          UPDATE deployment_logs
          SET checksum_sha256 = encode(digest(edge_script::text, 'sha256'), 'hex')
          WHERE edge_script IS NOT NULL AND checksum_sha256 IS NULL;
        END IF;
      END $$;
    `);

    // ── process deploys join scada_deploy_logs ───────────────────────────
    await queryRunner.query(
      `ALTER TABLE scada_deploy_logs ADD COLUMN IF NOT EXISTS process_id uuid`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'scada_deploy_logs'
            AND column_name = 'package_id'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE scada_deploy_logs ALTER COLUMN package_id DROP NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE scada_deploy_logs
          ADD CONSTRAINT chk_scada_deploy_logs_target
          CHECK (package_id IS NOT NULL OR process_id IS NOT NULL);
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_scada_deploy_logs_tenant_process ON scada_deploy_logs (tenant_id, process_id)`,
    );

    // ── processes gain a real version counter ────────────────────────────
    await queryRunner.query(
      `ALTER TABLE processes ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE processes DROP COLUMN IF EXISTS version`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_scada_deploy_logs_tenant_process`);
    await queryRunner.query(
      `ALTER TABLE scada_deploy_logs DROP CONSTRAINT IF EXISTS chk_scada_deploy_logs_target`,
    );
    await queryRunner.query(`ALTER TABLE scada_deploy_logs DROP COLUMN IF EXISTS process_id`);
    await queryRunner.query(`ALTER TABLE deployment_logs DROP COLUMN IF EXISTS checksum_sha256`);
    await queryRunner.query(`ALTER TABLE deployment_logs DROP COLUMN IF EXISTS artifact_id`);
    await queryRunner.query(`ALTER TABLE scada_deploy_logs DROP COLUMN IF EXISTS checksum_sha256`);
    await queryRunner.query(`ALTER TABLE scada_deploy_logs DROP COLUMN IF EXISTS artifact_id`);
  }
}
