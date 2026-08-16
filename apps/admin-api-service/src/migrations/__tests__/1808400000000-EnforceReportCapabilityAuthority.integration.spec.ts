import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import {
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_MAX_ARTIFACT_BYTES,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
} from '@platform/reporting-contracts';
import type { QueryRunner } from 'typeorm';

import { EnforceReportCapabilityAuthority1808400000000 } from '../1808400000000-EnforceReportCapabilityAuthority';

const DEFINITION_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';

async function installPredecessor(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await queryRunner.query('DROP SCHEMA IF EXISTS admin CASCADE');
  await queryRunner.query('CREATE SCHEMA admin');
  await queryRunner.query(`
    CREATE TABLE admin.retired_config_backups (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      "sourceTable" VARCHAR(64) NOT NULL,
      "rowData" JSONB NOT NULL,
      "archivedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE admin.report_definitions (
      id UUID PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      type VARCHAR(50) NOT NULL,
      "defaultFormat" VARCHAR(20) NOT NULL DEFAULT 'json',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      schedule VARCHAR(20) NOT NULL DEFAULT 'manual',
      recipients JSONB NULL,
      "includeCharts" BOOLEAN NOT NULL DEFAULT false,
      "lastRunAt" TIMESTAMPTZ NULL,
      "runCount" INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE admin.report_executions (
      id UUID PRIMARY KEY,
      "definitionId" UUID NULL,
      "reportName" VARCHAR(200) NOT NULL,
      "reportType" VARCHAR(50) NOT NULL,
      format VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      "startDate" TIMESTAMPTZ NULL,
      "endDate" TIMESTAMPTZ NULL,
      filters JSONB NULL,
      summary JSONB NULL,
      "rowCount" INTEGER NULL,
      "fileSizeBytes" INTEGER NULL,
      "artifactObjectKey" VARCHAR(1024) NULL,
      "artifactSha256" VARCHAR(64) NULL,
      "artifactContentType" VARCHAR(100) NULL,
      "downloadUrl" VARCHAR(500) NULL,
      "downloadExpiresAt" TIMESTAMPTZ NULL,
      "errorMessage" TEXT NULL,
      "durationMs" INTEGER NULL,
      "executedBy" UUID NULL,
      "executedByEmail" VARCHAR(255) NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "completedAt" TIMESTAMPTZ NULL
    )
  `);
  await queryRunner.query(
    `INSERT INTO admin.report_definitions (
       id, name, type, schedule, recipients, "includeCharts"
     ) VALUES (
       $1, 'Revenue Schedule', 'financial_revenue', 'daily',
       '["finance@example.test"]', true
     )`,
    [DEFINITION_ID],
  );
  await queryRunner.query(
    `INSERT INTO admin.report_executions (
       id, "definitionId", "reportName", "reportType", format, status,
       summary, "rowCount", "fileSizeBytes", "artifactObjectKey",
       "artifactSha256", "artifactContentType", "downloadUrl", "downloadExpiresAt"
     ) VALUES (
       $1, $2, 'Legacy Revenue', 'financial_revenue', 'csv', 'completed',
       '{"synthetic":true}', 1, 12, 'legacy.csv', $3, 'text/csv',
       '/api/reports/download/legacy', now() + interval '7 days'
     )`,
    [EXECUTION_ID, DEFINITION_ID, 'a'.repeat(64)],
  );
}

async function migrate(queryRunner: QueryRunner): Promise<void> {
  const migration = new EnforceReportCapabilityAuthority1808400000000();
  await queryRunner.startTransaction();
  try {
    await migration.up(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}

describe('report capability authority migration — real PostgreSQL contract', () => {
  let harness: HarnessContext | undefined;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    harness = await bootPostgresContainer({
      startTimeoutMs: 120_000,
      labels: { 'com.aqua-saas.test.role': 'report-capability-authority' },
    });
    queryRunner = harness.dataSource.createQueryRunner();
    await queryRunner.connect();
  }, 150_000);

  afterAll(async () => {
    await queryRunner?.release();
    await shutdownHarness(harness);
  }, 60_000);

  it('archives retired authorities and makes legacy artifacts unavailable', async () => {
    await installPredecessor(queryRunner);
    await migrate(queryRunner);

    const columns = (await queryRunner.query(`
      SELECT column_name AS name, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'admin'
        AND table_name IN ('report_definitions', 'report_executions')
    `)) as Array<{ name: string; nullable: string }>;
    expect(columns.some((column) => column.name === 'schedule')).toBe(false);
    expect(columns.some((column) => column.name === 'recipients')).toBe(false);
    expect(columns.some((column) => column.name === 'includeCharts')).toBe(false);
    expect(columns.some((column) => column.name === 'lastRunAt')).toBe(false);
    expect(columns.some((column) => column.name === 'runCount')).toBe(false);
    expect(columns.some((column) => column.name === 'downloadUrl')).toBe(false);
    expect(columns).toEqual(
      expect.arrayContaining([
        { name: 'capabilityCatalogSha256', nullable: 'NO' },
        { name: 'measurementCatalogSha256', nullable: 'NO' },
        { name: 'measurementState', nullable: 'NO' },
        { name: 'previewRows', nullable: 'YES' },
        { name: 'previewSha256', nullable: 'YES' },
        { name: 'measurementProof', nullable: 'YES' },
        { name: 'measurementProofSha256', nullable: 'YES' },
        { name: 'stagedArtifactObjectKey', nullable: 'YES' },
        { name: 'stagedArtifactSha256', nullable: 'YES' },
        { name: 'artifactCommitState', nullable: 'YES' },
        { name: 'authorityGraphSha256', nullable: 'NO' },
        { name: 'artifactMaximumBytes', nullable: 'NO' },
        { name: 'previewMaximumRows', nullable: 'NO' },
      ]),
    );

    const archives = (await queryRunner.query(`
      SELECT "sourceTable", "rowData"
      FROM admin.retired_config_backups
      ORDER BY "sourceTable"
    `)) as Array<{ sourceTable: string; rowData: Record<string, unknown> }>;
    expect(archives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTable: 'admin.report_definitions.retired-behavior-v0',
          rowData: {
            definitionId: DEFINITION_ID,
            includeCharts: true,
            lastRunAt: null,
            recipients: ['finance@example.test'],
            runCount: 0,
            schedule: 'daily',
          },
        }),
        expect.objectContaining({
          sourceTable: 'admin.report_executions.unqualified-v0',
          rowData: expect.objectContaining({
            id: EXECUTION_ID,
            artifactObjectKey: 'legacy.csv',
            downloadUrl: '/api/reports/download/legacy',
          }),
        }),
      ]),
    );

    const executions = (await queryRunner.query(`
      SELECT status, "measurementState", "capabilityCatalogSha256",
             "measurementCatalogSha256", "authorityGraphSha256",
             "artifactMaximumBytes", "previewMaximumRows",
             "artifactCommitState", "artifactObjectKey", "previewRows", "errorMessage"
      FROM admin.report_executions
    `)) as Array<Record<string, unknown>>;
    expect(executions).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        measurementState: 'BLOCKED',
        capabilityCatalogSha256: REPORT_CAPABILITY_CATALOG_SHA256,
        measurementCatalogSha256: REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
        authorityGraphSha256: REPORT_AUTHORITY_GRAPH_SHA256,
        artifactMaximumBytes: REPORT_MAX_ARTIFACT_BYTES,
        previewMaximumRows: 10,
        artifactCommitState: null,
        artifactObjectKey: null,
        previewRows: null,
        errorMessage: 'Legacy execution retired: no measurement authority qualification',
      }),
    ]);

    await expect(
      queryRunner.query(
        `UPDATE admin.report_executions SET "artifactObjectKey" = 'forbidden.csv'
         WHERE id = $1`,
        [EXECUTION_ID],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      queryRunner.query(
        `INSERT INTO admin.report_executions (
           id, "reportName", "reportType", format, status, "summary", "rowCount",
           "fileSizeBytes", "artifactObjectKey", "artifactSha256",
           "artifactContentType", "downloadExpiresAt", "previewRows",
           "previewSha256", "artifactCommitState",
           "capabilityCatalogSha256", "measurementCatalogSha256",
           "authorityGraphSha256", "artifactMaximumBytes",
           "previewMaximumRows", "measurementState", "durationMs", "completedAt"
         ) VALUES (
           $1::uuid, 'Invalid Qualified Revenue', 'financial_revenue', 'json', 'completed',
           '{}', 0, 1,
           'platform-admin/report-executions/' || $1::uuid::text || '/' || $2::text || '.json',
           $2::varchar, 'application/json', now() + interval '1 hour', NULL, NULL,
           'REFERENCE_COMMITTED', $3::varchar, $4::varchar,
           $5::varchar, $6::integer, 10, 'QUALIFIED', 1, now()
         )`,
        [
          '44444444-4444-4444-8444-444444444444',
          'b'.repeat(64),
          REPORT_CAPABILITY_CATALOG_SHA256,
          REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
          REPORT_AUTHORITY_GRAPH_SHA256,
          REPORT_MAX_ARTIFACT_BYTES,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      queryRunner.query('DELETE FROM admin.report_executions WHERE id = $1', [EXECUTION_ID]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('rejects a same-count archive with the wrong row identity before dropping columns', async () => {
    await installPredecessor(queryRunner);
    await queryRunner.query(`
      INSERT INTO admin.retired_config_backups ("sourceTable", "rowData")
      VALUES (
        'admin.report_definitions.retired-behavior-v0',
        jsonb_build_object(
          'definitionId', '33333333-3333-4333-8333-333333333333',
          'includeCharts', true,
          'recipients', jsonb_build_array('finance@example.test'),
          'schedule', 'daily'
        )
      )
    `);

    await expect(migrate(queryRunner)).rejects.toMatchObject({ code: '55000' });

    const columns = (await queryRunner.query(`
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = 'admin'
        AND table_name = 'report_definitions'
        AND column_name IN ('schedule', 'recipients', 'includeCharts', 'lastRunAt', 'runCount')
      ORDER BY column_name
    `)) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'includeCharts',
      'lastRunAt',
      'recipients',
      'runCount',
      'schedule',
    ]);
  });

  it('enforces the artifact commit state machine and immutable intent in PostgreSQL', async () => {
    await installPredecessor(queryRunner);
    await migrate(queryRunner);
    await queryRunner.query(`
      ALTER TABLE admin.report_executions
      DROP CONSTRAINT "chk_report_executions_catalog_generation_state"
    `);

    const executionId = '55555555-5555-4555-8555-555555555555';
    const previewSha256 = 'c'.repeat(64);
    const proofSha256 = 'd'.repeat(64);
    const artifactSha256 = 'e'.repeat(64);
    await queryRunner.query(
      `INSERT INTO admin.report_executions (
         id, "reportName", "reportType", format, status, summary, "rowCount",
         "fileSizeBytes", "artifactContentType", "previewRows", "previewSha256",
         "measurementProof", "measurementProofSha256", "stagedArtifactObjectKey",
         "stagedArtifactSha256", "artifactCommitState", "capabilityCatalogSha256",
         "measurementCatalogSha256", "authorityGraphSha256", "artifactMaximumBytes",
         "previewMaximumRows", "measurementState"
       ) VALUES (
         $1::uuid, 'Qualified Tenant Cut', 'tenant_overview', 'json', 'running',
         '{}'::jsonb, 0, 2, 'application/json', '[]'::jsonb, $2::varchar,
         jsonb_build_object(
           'schemaVersion', 'report-measurement-proof.v1',
           'reportType', 'tenant_overview',
           'capabilityCatalogSha256', $5::text,
           'measurementCatalogSha256', $6::text,
           'authorityGraphSha256', $7::text
         ),
         $3::varchar,
         'platform-admin/report-executions/' || $1::uuid::text || '/' || $4::text || '.json',
         $4::varchar, 'INTENT_CREATED', $5::varchar, $6::varchar, $7::varchar,
         1024, 10, 'QUALIFIED'
       )`,
      [
        executionId,
        previewSha256,
        proofSha256,
        artifactSha256,
        REPORT_CAPABILITY_CATALOG_SHA256,
        REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
        REPORT_AUTHORITY_GRAPH_SHA256,
      ],
    );

    await expect(
      queryRunner.query(
        `UPDATE admin.report_executions
         SET "artifactCommitState" = 'REFERENCE_COMMITTED'
         WHERE id = $1`,
        [executionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      queryRunner.query(
        `UPDATE admin.report_executions
         SET "artifactCommitState" = 'BYTES_VERIFIED', summary = '{"mutated":true}'
         WHERE id = $1`,
        [executionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const [verified] = (await queryRunner.query(
      `UPDATE admin.report_executions
       SET "artifactCommitState" = 'BYTES_VERIFIED'
       WHERE id = $1 AND "artifactCommitState" = 'INTENT_CREATED'
       RETURNING id`,
      [executionId],
    )) as [Array<{ id: string }>, number];
    expect(verified).toEqual([{ id: executionId }]);
    const [staleCas] = (await queryRunner.query(
      `UPDATE admin.report_executions
       SET "artifactCommitState" = 'BYTES_VERIFIED'
       WHERE id = $1 AND "artifactCommitState" = 'INTENT_CREATED'
       RETURNING id`,
      [executionId],
    )) as [Array<{ id: string }>, number];
    expect(staleCas).toEqual([]);

    await queryRunner.query(
      `UPDATE admin.report_executions
       SET status = 'completed',
           "artifactObjectKey" = "stagedArtifactObjectKey",
           "artifactSha256" = "stagedArtifactSha256",
           "stagedArtifactObjectKey" = NULL,
           "stagedArtifactSha256" = NULL,
           "artifactCommitState" = 'REFERENCE_COMMITTED',
           "downloadExpiresAt" = now() + interval '1 hour',
           "completedAt" = now(),
           "durationMs" = 1
       WHERE id = $1 AND "artifactCommitState" = 'BYTES_VERIFIED'`,
      [executionId],
    );
    const committed = (await queryRunner.query(
      `SELECT status, "artifactCommitState", "artifactSha256",
              "stagedArtifactSha256"
       FROM admin.report_executions WHERE id = $1`,
      [executionId],
    )) as Array<Record<string, unknown>>;
    expect(committed).toEqual([
      {
        status: 'completed',
        artifactCommitState: 'REFERENCE_COMMITTED',
        artifactSha256,
        stagedArtifactSha256: null,
      },
    ]);
  });
});
