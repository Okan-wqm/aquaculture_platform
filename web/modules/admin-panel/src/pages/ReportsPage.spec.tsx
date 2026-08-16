import {
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_AUTHORITY_GRAPH_SHA256,
  getReportCapability,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
} from '@platform/reporting-contracts';

import type { ReportExecutionDto } from '../services/adminApi';
import {
  decodeReportExecutionEvidence,
  decodeReportExecutionEvidencePage,
} from './reporting/report-execution-evidence';

function blockedExecution(): ReportExecutionDto {
  const capability = getReportCapability('tenant_overview');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reportName: 'Tenant Overview',
    reportType: 'tenant_overview',
    format: 'json',
    status: 'unavailable',
    capabilityCatalogSha256: REPORT_CAPABILITY_CATALOG_SHA256,
    measurementCatalogSha256: REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
    authorityGraphSha256: REPORT_AUTHORITY_GRAPH_SHA256,
    artifactMaximumBytes: capability.artifact.maximumBytes,
    previewMaximumRows: capability.preview.maximumRows,
    measurementState: 'BLOCKED',
    errorMessage: 'Billing and storage fact authorities are not wired',
    createdAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:00.001Z',
  };
}

describe('report execution evidence decoder', () => {
  it('projects a catalog-current blocked execution without inventing data', () => {
    expect(decodeReportExecutionEvidence(blockedExecution())).toEqual(
      expect.objectContaining({
        status: 'unavailable',
        data: undefined,
        errorMessage: 'Billing and storage fact authorities are not wired',
      }),
    );
  });

  it('rejects stale catalog coordinates', () => {
    expect(() =>
      decodeReportExecutionEvidence({
        ...blockedExecution(),
        capabilityCatalogSha256: 'a'.repeat(64),
      }),
    ).toThrow('stale authority catalog');
  });

  it('rejects an artifact attached to blocked measurement evidence', () => {
    expect(() =>
      decodeReportExecutionEvidence({
        ...blockedExecution(),
        artifactSha256: 'a'.repeat(64),
      }),
    ).toThrow('forbidden result or artifact');
  });

  it('rejects resource bounds that are not pinned to the catalog cut', () => {
    expect(() =>
      decodeReportExecutionEvidence({
        ...blockedExecution(),
        previewMaximumRows: 11,
      }),
    ).toThrow('resource bounds do not match its authority cut');
  });

  it('rejects a commit state attached to blocked evidence', () => {
    expect(() =>
      decodeReportExecutionEvidence({
        ...blockedExecution(),
        artifactCommitState: 'INTENT_CREATED',
      }),
    ).toThrow('forbidden result or artifact');
  });

  it('compiles report history through the platform pagination authority', () => {
    const page = decodeReportExecutionEvidencePage({
      items: [blockedExecution()],
      total: 3,
      page: 2,
      limit: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });

    expect(page.items).toHaveLength(1);
    expect(page).toEqual(
      expect.objectContaining({
        page: 2,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      }),
    );
  });

  it('rejects server pagination metadata that does not match the SSOT', () => {
    expect(() =>
      decodeReportExecutionEvidencePage({
        items: [blockedExecution()],
        total: 3,
        page: 2,
        limit: 1,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      }),
    ).toThrow('pagination metadata is non-canonical');
  });
});
