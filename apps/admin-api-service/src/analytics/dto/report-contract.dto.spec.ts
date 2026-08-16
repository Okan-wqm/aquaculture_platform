import { ReportDefinition, ReportExecution } from '../entities/analytics-snapshot.entity';

import { toReportDefinitionDto, toReportExecutionDto } from './report-contract.dto';

describe('report wire boundary null normalization', () => {
  it('omits nullable definition columns instead of leaking SQL null', () => {
    const definition = Object.assign(new ReportDefinition(), {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Revenue',
      description: null,
      type: 'financial_revenue' as const,
      defaultFormat: 'json' as const,
      status: 'active' as const,
      defaultFilters: null,
      createdBy: null,
      createdByEmail: null,
      createdAt: new Date('2026-08-08T00:00:00.000Z'),
      updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    });

    expect(toReportDefinitionDto(definition)).toEqual({
      id: definition.id,
      name: definition.name,
      type: definition.type,
      defaultFormat: definition.defaultFormat,
      status: definition.status,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    });
  });

  it('omits nullable execution columns from blocked history projections', () => {
    const execution = Object.assign(new ReportExecution(), {
      id: '22222222-2222-4222-8222-222222222222',
      definitionId: null,
      reportName: 'Revenue',
      reportType: 'financial_revenue' as const,
      format: 'json' as const,
      status: 'unavailable' as const,
      startDate: null,
      endDate: null,
      filters: null,
      summary: null,
      rowCount: null,
      fileSizeBytes: null,
      artifactObjectKey: null,
      artifactSha256: null,
      artifactContentType: null,
      downloadExpiresAt: null,
      previewRows: null,
      previewSha256: null,
      measurementProof: null,
      measurementProofSha256: null,
      stagedArtifactObjectKey: null,
      stagedArtifactSha256: null,
      artifactCommitState: null,
      capabilityCatalogSha256: 'a'.repeat(64),
      measurementCatalogSha256: 'b'.repeat(64),
      authorityGraphSha256: 'c'.repeat(64),
      artifactMaximumBytes: 1024,
      previewMaximumRows: 10,
      measurementState: 'BLOCKED' as const,
      errorMessage: 'No qualified facts',
      durationMs: 0,
      executedBy: null,
      executedByEmail: null,
      createdAt: new Date('2026-08-08T00:00:00.000Z'),
      completedAt: new Date('2026-08-08T00:00:00.001Z'),
    });

    const dto = toReportExecutionDto(execution);
    expect(dto.definitionId).toBeUndefined();
    expect(dto.summary).toBeUndefined();
    expect(dto.previewRows).toBeUndefined();
    expect(dto.measurementProof).toBeUndefined();
    expect(dto).toEqual(
      expect.objectContaining({
        status: 'unavailable',
        errorMessage: 'No qualified facts',
      }),
    );
  });
});
