import type { QueryRunner } from 'typeorm';
import {
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
} from '@platform/reporting-contracts';

import { EnforceReportCapabilityAuthority1808400000000 } from '../1808400000000-EnforceReportCapabilityAuthority';

describe('EnforceReportCapabilityAuthority1808400000000', () => {
  it('archives schedule state and installs fail-closed evidence coordinates', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new EnforceReportCapabilityAuthority1808400000000();

    await migration.up({ query } as Pick<QueryRunner, 'query'> as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('admin.report_definitions.retired-behavior-v0');
    expect(sql).toContain('LOCK TABLE admin.report_definitions IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE admin.report_executions IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('EXCEPT ALL');
    expect(sql).toContain('definition payloads do not exactly match source row identities');
    expect(sql).toContain('execution payloads do not exactly match source row identities');
    expect(sql).toContain('archived_definition_count <> retired_definition_count');
    expect(sql).toContain('admin.report_executions.unqualified-v0');
    expect(sql).toContain('archived_execution_count <> execution_count');
    expect(sql).toContain('DROP COLUMN "schedule"');
    expect(sql).toContain('DROP COLUMN "recipients"');
    expect(sql).toContain('DROP COLUMN "includeCharts"');
    expect(sql).toContain('DROP COLUMN "lastRunAt"');
    expect(sql).toContain('DROP COLUMN "runCount"');
    expect(sql).toContain('DROP COLUMN "downloadUrl"');
    expect(sql).toContain('"previewRows" JSONB');
    expect(sql).toContain('"measurementProof" JSONB');
    expect(sql).toContain('"measurementProofSha256" VARCHAR(64)');
    expect(sql).toContain('"stagedArtifactObjectKey" VARCHAR(1024)');
    expect(sql).toContain('"stagedArtifactSha256" VARCHAR(64)');
    expect(sql).toContain('"artifactCommitState" VARCHAR(32)');
    expect(sql).toContain('"authorityGraphSha256" VARCHAR(64)');
    expect(sql).toContain('"artifactMaximumBytes" INTEGER');
    expect(sql).toContain('"previewMaximumRows" INTEGER');
    expect(sql).toContain('ALTER COLUMN "capabilityCatalogSha256" SET NOT NULL');
    expect(sql).toContain('ALTER COLUMN "measurementCatalogSha256" SET NOT NULL');
    expect(sql).toContain('"measurementState" = \'BLOCKED\'');
    expect(sql).toContain('chk_report_executions_catalog_generation_state');
    expect(sql).toContain('"status" = \'unavailable\'');
    expect(sql).toContain('"fileSizeBytes" <= "artifactMaximumBytes"');
    expect(sql).toContain('jsonb_array_length("previewRows") <= "previewMaximumRows"');
    expect(sql).not.toMatch(/"fileSizeBytes"\s*<=\s*33554432/);
    expect(sql).not.toMatch(/jsonb_array_length\("previewRows"\)\s*<=\s*10/);
    expect(sql.match(/33554432::integer/g)).toHaveLength(1);
    expect(sql.match(/10::integer/g)).toHaveLength(1);
    expect(sql).toContain('INTENT_CREATED');
    expect(sql).toContain('BYTES_VERIFIED');
    expect(sql).toContain('REFERENCE_COMMITTED');
    expect(sql).toContain('illegal report artifact commit state transition');
    expect(sql).toContain('terminal report execution evidence is immutable');
    expect(sql).toContain('report execution evidence is append-only');
    expect(sql).toContain(REPORT_CAPABILITY_CATALOG_SHA256);
    expect(sql).toContain(REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256);
    expect(sql).toContain(REPORT_AUTHORITY_GRAPH_SHA256);
    expect(sql).not.toContain('ADD COLUMN IF NOT EXISTS');
  });

  it('refuses to restore the duplicate schedule authority', async () => {
    const migration = new EnforceReportCapabilityAuthority1808400000000();
    await expect(migration.down()).rejects.toThrow(
      'Report capability evidence and retired schedule authority are forward-only',
    );
  });
});
