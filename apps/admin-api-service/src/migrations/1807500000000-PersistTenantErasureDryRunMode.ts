import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes erasure execution mode durable and prevents an old orchestrator pod
 * from turning a dry-run into a tenant-schema deletion during rolling deploy.
 */
export class PersistTenantErasureDryRunMode1807500000000 implements MigrationInterface {
  name = 'PersistTenantErasureDryRunMode1807500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(`
      ALTER TABLE admin.tenant_erasure_operations
        ADD COLUMN IF NOT EXISTS "dryRun" boolean
    `);

    // The ALTER/explicit locks drain in-flight old handlers. After commit the
    // NOT NULL/no-default column makes any old binary fail its request INSERT
    // instead of accepting a mode it cannot persist.
    await queryRunner.query(`
      LOCK TABLE
        admin.tenant_erasure_operations,
        platform.tenant_schema_jobs
      IN SHARE ROW EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT outbox.payload->>'operationId'
            FROM admin.admin_outbox AS outbox
           WHERE outbox."eventType" = 'TenantErasureRequested'
             AND outbox.payload->>'operationId'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND outbox.payload->>'dryRun' IN ('true', 'false')
           GROUP BY outbox.payload->>'operationId'
          HAVING COUNT(DISTINCT outbox.payload->>'dryRun') > 1
        ) THEN
          RAISE EXCEPTION
            'conflicting historical tenant-erasure dry-run modes found in durable outbox evidence'
            USING ERRCODE = '55000';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      WITH request_modes AS (
        SELECT DISTINCT ON ((outbox.payload->>'operationId')::uuid)
               (outbox.payload->>'operationId')::uuid AS operation_id,
               (outbox.payload->>'dryRun')::boolean AS dry_run
          FROM admin.admin_outbox AS outbox
         WHERE outbox."eventType" = 'TenantErasureRequested'
           AND outbox.payload->>'operationId'
                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND outbox.payload->>'dryRun' IN ('true', 'false')
         ORDER BY (outbox.payload->>'operationId')::uuid,
                  outbox."createdAt" DESC,
                  outbox.id DESC
      )
      UPDATE admin.tenant_erasure_operations AS operation
         SET "dryRun" = request_modes.dry_run,
             "updatedAt" = NOW()
        FROM request_modes
       WHERE operation.id = request_modes.operation_id
         AND operation."dryRun" IS NULL
    `);
    await queryRunner.query(`
      UPDATE admin.tenant_erasure_operations
         SET status = 'FAILED',
             failures = COALESCE(failures, '[]'::jsonb) || jsonb_build_array(
               jsonb_build_object(
                 'eventType', 'TenantErasureModeBackfillFailed',
                 'targetService', 'platform-orchestrator',
                 'reason', 'Historical erasure mode could not be proven from the durable outbox',
                 'occurredAt', NOW()
               )
             ),
             "updatedAt" = NOW()
       WHERE status = 'IN_PROGRESS'
         AND "dryRun" IS NULL
    `);
    await queryRunner.query(`
      UPDATE admin.tenant_erasure_operations
         SET "dryRun" = false,
             "updatedAt" = NOW()
       WHERE "dryRun" IS NULL
    `);
    await queryRunner.query(`
      UPDATE admin.tenant_erasure_operations AS operation
         SET status = 'FAILED',
             failures = COALESCE(operation.failures, '[]'::jsonb) || jsonb_build_array(
               jsonb_build_object(
                 'eventType', 'TenantErasureProofModeMismatch',
                 'targetService', 'platform-orchestrator',
                 'reason', 'Historical proof mode or dry-run erased count is invalid',
                 'occurredAt', NOW()
               )
             ),
             "updatedAt" = NOW()
       WHERE operation.status = 'IN_PROGRESS'
         AND EXISTS (
           SELECT 1
             FROM unnest(operation."targetServices") AS target(service)
            WHERE operation.proofs ? target.service
              AND (
                CASE
                  WHEN jsonb_typeof(
                    operation.proofs -> target.service -> 'dryRun'
                  ) = 'boolean'
                    THEN (
                      operation.proofs -> target.service ->> 'dryRun'
                    )::boolean IS DISTINCT FROM operation."dryRun"
                  ELSE true
                END
                OR (
                  operation."dryRun"
                  AND CASE
                    WHEN jsonb_typeof(
                      operation.proofs -> target.service -> 'erasedRecordCount'
                    ) = 'number'
                      THEN (
                        operation.proofs -> target.service ->> 'erasedRecordCount'
                      )::numeric <> 0
                    ELSE true
                  END
                )
              )
         )
    `);

    // A completed DELETE job for a proven dry run means destructive work has
    // already occurred under the wrong mode. Do not let deployment normalize
    // that incident into an apparently healthy operation: stop and require a
    // forensic/manual recovery decision.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM platform.tenant_schema_jobs AS job
            JOIN admin.tenant_erasure_operations AS operation
              ON operation.id = job.operation_id
           WHERE job.job_type = 'DELETE'
             AND job.status = 'DELETED'
             AND operation."dryRun" = true
        ) THEN
          RAISE EXCEPTION
            'historical tenant-erasure dry run has a completed schema deletion job; manual incident recovery is required'
            USING ERRCODE = '55000';
        END IF;
      END
      $$
    `);

    // Stop any already-requested dry-run deletion job before installing the
    // permanent guard. A leased worker loses its update atomically and cannot
    // commit a DROP after this migration holds the jobs table lock.
    await queryRunner.query(`
      UPDATE platform.tenant_schema_jobs AS job
         SET status = 'ABORTED',
             error_message = 'aborted: operation is a tenant-erasure dry run',
             lease_token = NULL,
             leased_by = NULL,
             lease_expires_at = NULL,
             completed_at = NOW(),
             updated_at = NOW()
        FROM admin.tenant_erasure_operations AS operation
       WHERE job.operation_id = operation.id
         AND job.job_type = 'DELETE'
         AND operation."dryRun" = true
         AND job.status NOT IN ('DELETED', 'FAILED', 'ABORTED')
    `);
    await queryRunner.query(`
      UPDATE admin.tenant_erasure_operations AS operation
         SET status = 'FAILED',
             failures = COALESCE(operation.failures, '[]'::jsonb) || jsonb_build_array(
               jsonb_build_object(
                 'eventType', 'TenantErasureDryRunSchemaDeletionRejected',
                 'targetService', 'platform-orchestrator',
                 'reason', 'Historical dry-run operation contains a schema deletion job',
                 'occurredAt', NOW()
               )
             ),
             "updatedAt" = NOW()
       WHERE operation.status = 'IN_PROGRESS'
         AND operation."dryRun" = true
         AND EXISTS (
           SELECT 1
             FROM platform.tenant_schema_jobs AS job
            WHERE job.operation_id = operation.id
              AND job.job_type = 'DELETE'
         )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.reject_dry_run_schema_deletion_job()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF NEW.job_type = 'DELETE'
           AND EXISTS (
             SELECT 1
               FROM admin.tenant_erasure_operations AS operation
              WHERE operation.id = NEW.operation_id
                AND operation."dryRun" = true
           ) THEN
          RAISE EXCEPTION
            'tenant schema deletion rejected because erasure operation is a dry run'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      ALTER FUNCTION admin.reject_dry_run_schema_deletion_job()
        OWNER TO admin_schema_owner
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION admin.reject_dry_run_schema_deletion_job()
        FROM PUBLIC
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_reject_dry_run_schema_deletion_job"
        ON platform.tenant_schema_jobs
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_reject_dry_run_schema_deletion_job"
      BEFORE INSERT OR UPDATE ON platform.tenant_schema_jobs
      FOR EACH ROW
      EXECUTE FUNCTION admin.reject_dry_run_schema_deletion_job()
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'admin'
             AND table_name = 'tenant_erasure_operations'
             AND column_name = 'dryRun'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE admin.tenant_erasure_operations
            ALTER COLUMN "dryRun" SET NOT NULL;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_erasure_operations_request_recovery
        ON admin.tenant_erasure_operations ("updatedAt", id)
        WHERE status = 'IN_PROGRESS'
          AND "schemaDeletionJobId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        RAISE EXCEPTION
          'cannot roll back persisted tenant-erasure dry-run semantics safely';
      END
      $$
    `);
  }
}
