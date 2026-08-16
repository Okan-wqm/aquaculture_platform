import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires the never-executed scheduling/delivery presentation fields and installs the durable
 * evidence coordinates required by ReportCapabilityCatalogV1.
 *
 * The migration is intentionally drift-intolerant. It accepts only the exact
 * predecessor shape, locks every source/retirement table, verifies exact
 * bidirectional row-identity and payload parity, and refuses a rollback that
 * would recreate the second scheduling authority.
 */
export class EnforceReportCapabilityAuthority1808400000000 implements MigrationInterface {
  name = 'EnforceReportCapabilityAuthority1808400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        retired_definition_count bigint;
        archived_definition_count bigint;
        execution_count bigint;
        archived_execution_count bigint;
      BEGIN
        IF to_regclass('admin.report_definitions') IS NULL
          OR to_regclass('admin.report_executions') IS NULL
          OR to_regclass('admin.retired_config_backups') IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'report capability migration requires the exact admin predecessor tables';
        END IF;

        LOCK TABLE admin.report_definitions IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE admin.report_executions IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE admin.retired_config_backups IN SHARE ROW EXCLUSIVE MODE;

        IF (
          SELECT count(*)
          FROM information_schema.columns
          WHERE table_schema = 'admin'
            AND table_name = 'report_definitions'
            AND (
              (column_name = 'schedule' AND data_type = 'character varying' AND is_nullable = 'NO')
              OR (column_name = 'recipients' AND data_type = 'jsonb' AND is_nullable = 'YES')
              OR (column_name = 'includeCharts' AND data_type = 'boolean' AND is_nullable = 'NO')
              OR (column_name = 'lastRunAt' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES')
              OR (column_name = 'runCount' AND data_type = 'integer' AND is_nullable = 'NO')
            )
        ) <> 5 THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'admin.report_definitions automation predecessor shape is missing or stale';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'admin'
            AND table_name = 'report_executions'
            AND column_name IN (
              'previewRows',
              'previewSha256',
              'artifactCommitState',
              'capabilityCatalogSha256',
              'measurementCatalogSha256',
              'authorityGraphSha256',
              'artifactMaximumBytes',
              'previewMaximumRows',
              'measurementState'
            )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'admin.report_executions already contains a partial report authority projection';
        END IF;

        SELECT count(*) INTO retired_definition_count
          FROM admin.report_definitions;

        IF NOT EXISTS (
          SELECT 1
          FROM admin.retired_config_backups
          WHERE "sourceTable" = 'admin.report_definitions.retired-behavior-v0'
        ) THEN
          INSERT INTO admin.retired_config_backups ("sourceTable", "rowData")
          SELECT
            'admin.report_definitions.retired-behavior-v0',
            jsonb_build_object(
              'definitionId', "id",
              'includeCharts', "includeCharts",
              'lastRunAt', "lastRunAt",
              'recipients', "recipients",
              'runCount', "runCount",
              'schedule', "schedule"
            )
          FROM admin.report_definitions
          ORDER BY "id";
        END IF;

        SELECT count(*) INTO archived_definition_count
          FROM admin.retired_config_backups
          WHERE "sourceTable" = 'admin.report_definitions.retired-behavior-v0';

        IF archived_definition_count <> retired_definition_count THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = format(
              'retired report definition behavior contains %s rows for %s definitions; refusing retirement',
              archived_definition_count,
              retired_definition_count
            );
        END IF;

        IF EXISTS (
          (
            SELECT jsonb_build_object(
              'definitionId', "id",
              'includeCharts', "includeCharts",
              'lastRunAt', "lastRunAt",
              'recipients', "recipients",
              'runCount', "runCount",
              'schedule', "schedule"
            ) AS payload
            FROM admin.report_definitions
            EXCEPT ALL
            SELECT "rowData"
            FROM admin.retired_config_backups
            WHERE "sourceTable" = 'admin.report_definitions.retired-behavior-v0'
          )
          UNION ALL
          (
            SELECT "rowData"
            FROM admin.retired_config_backups
            WHERE "sourceTable" = 'admin.report_definitions.retired-behavior-v0'
            EXCEPT ALL
            SELECT jsonb_build_object(
              'definitionId', "id",
              'includeCharts', "includeCharts",
              'lastRunAt', "lastRunAt",
              'recipients', "recipients",
              'runCount', "runCount",
              'schedule', "schedule"
            ) AS payload
            FROM admin.report_definitions
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'retired report definition payloads do not exactly match source row identities';
        END IF;

        SELECT count(*) INTO execution_count
          FROM admin.report_executions;

        IF NOT EXISTS (
          SELECT 1
          FROM admin.retired_config_backups
          WHERE "sourceTable" = 'admin.report_executions.unqualified-v0'
        ) THEN
          INSERT INTO admin.retired_config_backups ("sourceTable", "rowData")
          SELECT
            'admin.report_executions.unqualified-v0',
            to_jsonb(execution)
          FROM admin.report_executions execution
          ORDER BY "id";
        END IF;

        SELECT count(*) INTO archived_execution_count
          FROM admin.retired_config_backups
          WHERE "sourceTable" = 'admin.report_executions.unqualified-v0';

        IF archived_execution_count <> execution_count THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = format(
              'retired report executions contain %s rows for %s legacy executions; refusing qualification reset',
              archived_execution_count,
              execution_count
            );
        END IF;

        IF EXISTS (
          (
            SELECT to_jsonb(execution) AS payload
            FROM admin.report_executions execution
            EXCEPT ALL
            SELECT "rowData"
            FROM admin.retired_config_backups
            WHERE "sourceTable" = 'admin.report_executions.unqualified-v0'
          )
          UNION ALL
          (
            SELECT "rowData"
            FROM admin.retired_config_backups
            WHERE "sourceTable" = 'admin.report_executions.unqualified-v0'
            EXCEPT ALL
            SELECT to_jsonb(execution) AS payload
            FROM admin.report_executions execution
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'retired report execution payloads do not exactly match source row identities';
        END IF;
      END $$
    `);

    await queryRunner.query(`
      ALTER TABLE admin.report_definitions
        DROP COLUMN "schedule",
        DROP COLUMN "recipients",
        DROP COLUMN "includeCharts",
        DROP COLUMN "lastRunAt",
        DROP COLUMN "runCount"
    `);

    await queryRunner.query(`
      ALTER TABLE admin.report_executions
        ADD COLUMN "previewRows" JSONB NULL,
        ADD COLUMN "previewSha256" VARCHAR(64) NULL,
        ADD COLUMN "measurementProof" JSONB NULL,
        ADD COLUMN "measurementProofSha256" VARCHAR(64) NULL,
        ADD COLUMN "stagedArtifactObjectKey" VARCHAR(1024) NULL,
        ADD COLUMN "stagedArtifactSha256" VARCHAR(64) NULL,
        ADD COLUMN "artifactCommitState" VARCHAR(32) NULL,
        ADD COLUMN "capabilityCatalogSha256" VARCHAR(64) NULL,
        ADD COLUMN "measurementCatalogSha256" VARCHAR(64) NULL,
        ADD COLUMN "authorityGraphSha256" VARCHAR(64) NULL,
        ADD COLUMN "artifactMaximumBytes" INTEGER NULL,
        ADD COLUMN "previewMaximumRows" INTEGER NULL,
        ADD COLUMN "measurementState" VARCHAR(20) NULL
    `);

    await queryRunner.query(`
      UPDATE admin.report_executions AS execution
      SET
        "status" = 'unavailable',
        "summary" = NULL,
        "rowCount" = NULL,
        "fileSizeBytes" = NULL,
        "artifactObjectKey" = NULL,
        "artifactSha256" = NULL,
        "artifactContentType" = NULL,
        "downloadExpiresAt" = NULL,
        "errorMessage" = 'Legacy execution retired: no measurement authority qualification',
        "completedAt" = COALESCE("completedAt", now()),
        "durationMs" = COALESCE("durationMs", 0),
        "capabilityCatalogSha256" = authority_cut.capability_catalog_sha256,
        "measurementCatalogSha256" = authority_cut.measurement_catalog_sha256,
        "authorityGraphSha256" = authority_cut.authority_graph_sha256,
        "artifactMaximumBytes" = authority_cut.artifact_maximum_bytes,
        "previewMaximumRows" = authority_cut.preview_maximum_rows,
        "measurementState" = 'BLOCKED'
      FROM (
        -- Immutable historical v1 cut: numeric bounds are inseparable from
        -- the three catalog/graph digests in this one-time legacy backfill.
        VALUES (
          '40be1c7a86c8662d3b9ad5dfc08c4089dc0720c1a345d6fdfea1d4689c53c5b4'::varchar,
          '9df6dc8f33776420cb7f254ea7bc876de05ebad81138acbd4bf2219c09ac101c'::varchar,
          '001a50131119ffa5930e271ecf1765d1b6c2b13fdc3e1a89d9d8b1c4c7cfd28c'::varchar,
          33554432::integer,
          10::integer
        )
      ) AS authority_cut(
        capability_catalog_sha256,
        measurement_catalog_sha256,
        authority_graph_sha256,
        artifact_maximum_bytes,
        preview_maximum_rows
      )
    `);

    await queryRunner.query(`
      ALTER TABLE admin.report_executions
        DROP COLUMN "downloadUrl",
        ALTER COLUMN "capabilityCatalogSha256" SET NOT NULL,
        ALTER COLUMN "measurementCatalogSha256" SET NOT NULL,
        ALTER COLUMN "authorityGraphSha256" SET NOT NULL,
        ALTER COLUMN "artifactMaximumBytes" SET NOT NULL,
        ALTER COLUMN "previewMaximumRows" SET NOT NULL,
        ALTER COLUMN "measurementState" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE admin.report_executions
        ADD CONSTRAINT "chk_report_executions_measurement_state"
          CHECK ("measurementState" IN ('BLOCKED', 'QUALIFIED')),
        ADD CONSTRAINT "chk_report_executions_artifact_commit_state"
          CHECK (
            "artifactCommitState" IS NULL
            OR "artifactCommitState" IN (
              'INTENT_CREATED', 'BYTES_VERIFIED', 'REFERENCE_COMMITTED'
            )
          ),
        ADD CONSTRAINT "chk_report_executions_catalog_generation_state"
          CHECK ("measurementState" = 'BLOCKED'),
        ADD CONSTRAINT "chk_report_executions_authority_digests"
          CHECK (
            "capabilityCatalogSha256" ~ '^[0-9a-f]{64}$'
            AND "measurementCatalogSha256" ~ '^[0-9a-f]{64}$'
            AND "authorityGraphSha256" ~ '^[0-9a-f]{64}$'
          ),
        ADD CONSTRAINT "chk_report_executions_pinned_resource_bounds"
          CHECK (
            "artifactMaximumBytes" > 0
            AND "previewMaximumRows" >= 0
            AND (
              "fileSizeBytes" IS NULL
              OR (
                "fileSizeBytes" >= 0
                AND "fileSizeBytes" <= "artifactMaximumBytes"
              )
            )
            AND (
              "previewRows" IS NULL
              OR (
                jsonb_typeof("previewRows") = 'array'
                AND jsonb_array_length("previewRows") <= "previewMaximumRows"
              )
            )
          ),
        ADD CONSTRAINT "chk_report_executions_evidence_shape"
          CHECK (
            (
              "measurementState" = 'BLOCKED'
              AND "status" = 'unavailable'
              AND "errorMessage" IS NOT NULL
              AND "summary" IS NULL
              AND "rowCount" IS NULL
              AND "artifactObjectKey" IS NULL
              AND "artifactSha256" IS NULL
              AND "artifactContentType" IS NULL
              AND "fileSizeBytes" IS NULL
              AND "downloadExpiresAt" IS NULL
              AND "previewRows" IS NULL
              AND "previewSha256" IS NULL
              AND "measurementProof" IS NULL
              AND "measurementProofSha256" IS NULL
              AND "stagedArtifactObjectKey" IS NULL
              AND "stagedArtifactSha256" IS NULL
              AND "artifactCommitState" IS NULL
              AND "completedAt" IS NOT NULL
              AND "durationMs" IS NOT NULL
              AND "durationMs" >= 0
            )
            OR
            (
              "measurementState" = 'QUALIFIED'
              AND (
                (
                  "status" = 'completed'
                  AND "artifactCommitState" = 'REFERENCE_COMMITTED'
                  AND "errorMessage" IS NULL
                  AND "completedAt" IS NOT NULL
                  AND "durationMs" IS NOT NULL
                  AND "durationMs" >= 0
                  AND "summary" IS NOT NULL
                  AND "rowCount" IS NOT NULL
                  AND "rowCount" >= 0
                  AND "artifactObjectKey" IS NOT NULL
                  AND "artifactObjectKey" =
                    'platform-admin/report-executions/' || "id"::text || '/' ||
                    "artifactSha256" || '.' || "format"
                  AND "artifactSha256" IS NOT NULL
                  AND "artifactSha256" ~ '^[0-9a-f]{64}$'
                  AND "artifactContentType" IS NOT NULL
                  AND (
                    ("format" = 'json' AND "artifactContentType" = 'application/json')
                    OR ("format" = 'csv' AND "artifactContentType" = 'text/csv')
                    OR ("format" = 'pdf' AND "artifactContentType" = 'application/pdf')
                  )
                  AND "fileSizeBytes" IS NOT NULL
                  AND "downloadExpiresAt" IS NOT NULL
                  AND "downloadExpiresAt" > "completedAt"
                  AND "previewRows" IS NOT NULL
                  AND "rowCount" >= jsonb_array_length("previewRows")
                  AND "previewSha256" IS NOT NULL
                  AND "previewSha256" ~ '^[0-9a-f]{64}$'
                  AND "measurementProof" IS NOT NULL
                  AND jsonb_typeof("measurementProof") = 'object'
                  AND "measurementProof"->>'schemaVersion' = 'report-measurement-proof.v1'
                  AND "measurementProof"->>'reportType' = "reportType"
                  AND "measurementProof"->>'capabilityCatalogSha256' = "capabilityCatalogSha256"
                  AND "measurementProof"->>'measurementCatalogSha256' = "measurementCatalogSha256"
                  AND "measurementProof"->>'authorityGraphSha256' = "authorityGraphSha256"
                  AND "measurementProofSha256" IS NOT NULL
                  AND "measurementProofSha256" ~ '^[0-9a-f]{64}$'
                  AND "stagedArtifactObjectKey" IS NULL
                  AND "stagedArtifactSha256" IS NULL
                )
                OR
                (
                  "status" IN ('pending', 'running')
                  AND "artifactCommitState" IS NULL
                  AND "errorMessage" IS NULL
                  AND "completedAt" IS NULL
                  AND "durationMs" IS NULL
                  AND "summary" IS NULL
                  AND "rowCount" IS NULL
                  AND "artifactObjectKey" IS NULL
                  AND "artifactSha256" IS NULL
                  AND "artifactContentType" IS NULL
                  AND "fileSizeBytes" IS NULL
                  AND "downloadExpiresAt" IS NULL
                  AND "previewRows" IS NULL
                  AND "previewSha256" IS NULL
                  AND "measurementProof" IS NULL
                  AND "measurementProofSha256" IS NULL
                  AND "stagedArtifactObjectKey" IS NULL
                  AND "stagedArtifactSha256" IS NULL
                )
                OR
                (
                  "status" = 'running'
                  AND "artifactCommitState" IN ('INTENT_CREATED', 'BYTES_VERIFIED')
                  AND "errorMessage" IS NULL
                  AND "completedAt" IS NULL
                  AND "durationMs" IS NULL
                  AND "summary" IS NOT NULL
                  AND "rowCount" IS NOT NULL
                  AND "rowCount" >= 0
                  AND "artifactObjectKey" IS NULL
                  AND "artifactSha256" IS NULL
                  AND "artifactContentType" IS NOT NULL
                  AND (
                    ("format" = 'json' AND "artifactContentType" = 'application/json')
                    OR ("format" = 'csv' AND "artifactContentType" = 'text/csv')
                    OR ("format" = 'pdf' AND "artifactContentType" = 'application/pdf')
                  )
                  AND "fileSizeBytes" IS NOT NULL
                  AND "downloadExpiresAt" IS NULL
                  AND "previewRows" IS NOT NULL
                  AND "rowCount" >= jsonb_array_length("previewRows")
                  AND "previewSha256" IS NOT NULL
                  AND "previewSha256" ~ '^[0-9a-f]{64}$'
                  AND "measurementProof" IS NOT NULL
                  AND jsonb_typeof("measurementProof") = 'object'
                  AND "measurementProof"->>'schemaVersion' = 'report-measurement-proof.v1'
                  AND "measurementProof"->>'reportType' = "reportType"
                  AND "measurementProof"->>'capabilityCatalogSha256' = "capabilityCatalogSha256"
                  AND "measurementProof"->>'measurementCatalogSha256' = "measurementCatalogSha256"
                  AND "measurementProof"->>'authorityGraphSha256' = "authorityGraphSha256"
                  AND "measurementProofSha256" IS NOT NULL
                  AND "measurementProofSha256" ~ '^[0-9a-f]{64}$'
                  AND "stagedArtifactSha256" IS NOT NULL
                  AND "stagedArtifactSha256" ~ '^[0-9a-f]{64}$'
                  AND "stagedArtifactObjectKey" =
                    'platform-admin/report-executions/' || "id"::text || '/' ||
                    "stagedArtifactSha256" || '.' || "format"
                )
                OR
                (
                  "status" = 'failed'
                  AND "artifactCommitState" IS NULL
                  AND COALESCE("errorMessage", '') <> ''
                  AND "completedAt" IS NOT NULL
                  AND "durationMs" IS NOT NULL
                  AND "durationMs" >= 0
                  AND "summary" IS NULL
                  AND "rowCount" IS NULL
                  AND "artifactObjectKey" IS NULL
                  AND "artifactSha256" IS NULL
                  AND "artifactContentType" IS NULL
                  AND "fileSizeBytes" IS NULL
                  AND "downloadExpiresAt" IS NULL
                  AND "previewRows" IS NULL
                  AND "previewSha256" IS NULL
                  AND "measurementProof" IS NULL
                  AND "measurementProofSha256" IS NULL
                  AND "stagedArtifactObjectKey" IS NULL
                  AND "stagedArtifactSha256" IS NULL
                )
              )
            )
          )
    `);

    await queryRunner.query(`
      CREATE FUNCTION admin.guard_terminal_report_execution_evidence_v1()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, admin
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'report execution evidence is append-only and cannot be deleted';
        END IF;
        IF OLD."status" IN ('completed', 'failed', 'unavailable')
          AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'terminal report execution evidence is immutable';
        END IF;
        IF NEW."artifactCommitState" IS DISTINCT FROM OLD."artifactCommitState" THEN
          IF NOT (
            (OLD."artifactCommitState" IS NULL
              AND NEW."artifactCommitState" = 'INTENT_CREATED')
            OR (OLD."artifactCommitState" = 'INTENT_CREATED'
              AND NEW."artifactCommitState" = 'BYTES_VERIFIED')
            OR (OLD."artifactCommitState" = 'BYTES_VERIFIED'
              AND NEW."artifactCommitState" = 'REFERENCE_COMMITTED')
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = '55000',
              MESSAGE = 'illegal report artifact commit state transition';
          END IF;
        END IF;
        IF OLD."artifactCommitState" = 'INTENT_CREATED'
          AND NEW."artifactCommitState" = 'BYTES_VERIFIED'
          AND (to_jsonb(NEW) - 'artifactCommitState') IS DISTINCT FROM
              (to_jsonb(OLD) - 'artifactCommitState') THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'artifact bytes verification cannot rewrite its durable intent';
        END IF;
        IF OLD."artifactCommitState" = 'BYTES_VERIFIED'
          AND NEW."artifactCommitState" = 'REFERENCE_COMMITTED'
          AND (
            NEW."artifactObjectKey" IS DISTINCT FROM OLD."stagedArtifactObjectKey"
            OR NEW."artifactSha256" IS DISTINCT FROM OLD."stagedArtifactSha256"
            OR NEW."summary" IS DISTINCT FROM OLD."summary"
            OR NEW."rowCount" IS DISTINCT FROM OLD."rowCount"
            OR NEW."fileSizeBytes" IS DISTINCT FROM OLD."fileSizeBytes"
            OR NEW."artifactContentType" IS DISTINCT FROM OLD."artifactContentType"
            OR NEW."previewRows" IS DISTINCT FROM OLD."previewRows"
            OR NEW."previewSha256" IS DISTINCT FROM OLD."previewSha256"
            OR NEW."measurementProof" IS DISTINCT FROM OLD."measurementProof"
            OR NEW."measurementProofSha256" IS DISTINCT FROM OLD."measurementProofSha256"
          ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'artifact reference commit does not match its verified intent';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER trg_guard_terminal_report_execution_evidence_v1
      BEFORE UPDATE OR DELETE ON admin.report_executions
      FOR EACH ROW
      EXECUTE FUNCTION admin.guard_terminal_report_execution_evidence_v1()
    `);
  }

  public async down(): Promise<void> {
    throw new Error('Report capability evidence and retired schedule authority are forward-only');
  }
}
