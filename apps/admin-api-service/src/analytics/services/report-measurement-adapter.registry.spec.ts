import {
  COMPILED_REPORT_AUTHORITY_GRAPH,
  REPORT_CAPABILITY_CATALOG,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG,
  compileReportMeasurementAdapterBuildAttestation,
  compileReportMeasurementAdapterBuildAttestationSet,
  compileReportAuthorityGraph,
  compileReportMeasurementIntent,
  type ReportMeasurementAuthorityCatalogV1,
  type ReportType,
} from '@platform/reporting-contracts';

import {
  ReportMeasurementAdapterRegistry,
  type MeasuredReportDatasetV1,
  type ReportMeasurementAdapterV1,
} from './report-measurement-adapter.registry';

function blockedAdapter(reportType: ReportType): ReportMeasurementAdapterV1 {
  const authority = REPORT_MEASUREMENT_AUTHORITY_CATALOG.entries.find(
    (entry) => entry.reportType === reportType,
  );
  if (!authority) throw new Error('test authority is missing');
  return {
    adapterId: 'forbidden-synthetic-adapter.v1',
    reportType,
    measurementAuthorityId: authority.authorityId,
    measure: jest.fn(),
  };
}

describe('ReportMeasurementAdapterRegistry', () => {
  it('compiles build provenance as an exact set over qualified catalog bindings', () => {
    const compiled = compileReportMeasurementAdapterBuildAttestationSet(
      COMPILED_REPORT_AUTHORITY_GRAPH,
      [],
    );
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.attestations)).toBe(true);
    expect(compiled.authorityGraphSha256).toBe(COMPILED_REPORT_AUTHORITY_GRAPH.graphSha256);
    expect(compiled.setSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the exact empty registry while every authority is blocked', () => {
    expect(
      () => new ReportMeasurementAdapterRegistry(COMPILED_REPORT_AUTHORITY_GRAPH, [], []),
    ).not.toThrow();
  });

  it('rejects an implementation attached to a blocked measurement authority', () => {
    expect(
      () =>
        new ReportMeasurementAdapterRegistry(
          COMPILED_REPORT_AUTHORITY_GRAPH,
          [blockedAdapter('financial_revenue')],
          [],
        ),
    ).toThrow('cannot attach to blocked authority');
  });

  it('binds a qualified adapter to the exact graph and emits source-cut evidence', async () => {
    const adapterBinding = {
      adapterId: 'tenant-overview-adapter.v1',
      implementationSha256: 'a'.repeat(64),
      provenanceSha256: 'b'.repeat(64),
    } as const;
    const measurementCatalog: ReportMeasurementAuthorityCatalogV1 = {
      schemaVersion: 'report-measurement-authority-catalog.v1',
      entries: REPORT_MEASUREMENT_AUTHORITY_CATALOG.entries.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              state: 'QUALIFIED',
              blocker: null,
              qualifiedAdapter: adapterBinding,
            }
          : entry,
      ),
    };
    const authorityGraph = compileReportAuthorityGraph(
      REPORT_CAPABILITY_CATALOG,
      measurementCatalog,
    );
    const intent = compileReportMeasurementIntent({
      reportType: 'tenant_overview',
      startInclusiveUtc: null,
      endExclusiveUtc: null,
      filters: { plans: ['professional'] },
      currentTimeUtc: '2026-08-08T12:00:00.000Z',
    });
    const adapter: ReportMeasurementAdapterV1 = {
      adapterId: adapterBinding.adapterId,
      reportType: 'tenant_overview',
      measurementAuthorityId: 'tenant-overview-facts.v1',
      measure: jest.fn(
        async (receivedIntent): Promise<MeasuredReportDatasetV1> => ({
          schemaVersion: 'measured-report-dataset.v1',
          reportType: 'tenant_overview',
          measurementAuthorityId: 'tenant-overview-facts.v1',
          measurementCatalogSha256: authorityGraph.measurementCatalogSha256,
          intentSha256: receivedIntent.intentSha256,
          generatedAt: new Date('2026-08-08T11:59:59.000Z'),
          rows: [{ tenantId: 'tenant-1', status: 'active' }],
          summary: { tenantCount: 1 },
          factEvidence: measurementCatalog.entries[0]!.requiredFacts.map((factId, index) => ({
            factId,
            sourceCutSha256: index.toString(16).padStart(64, '0'),
          })),
        }),
      ),
    };

    const attestation = compileReportMeasurementAdapterBuildAttestation(authorityGraph, {
      schemaVersion: 'report-measurement-adapter-build-attestation.v1',
      issuer: 'admin-reporting-build-bootstrap.v1',
      adapterId: adapterBinding.adapterId,
      reportType: 'tenant_overview',
      measurementAuthorityId: 'tenant-overview-facts.v1',
      implementationSha256: adapterBinding.implementationSha256,
      provenanceSha256: adapterBinding.provenanceSha256,
      authorityGraphSha256: authorityGraph.graphSha256,
    });
    expect(() => new ReportMeasurementAdapterRegistry(authorityGraph, [adapter], [])).toThrow(
      'no independent compiler-minted build attestation',
    );

    const registry = new ReportMeasurementAdapterRegistry(authorityGraph, [adapter], [attestation]);
    const result = await registry.measure(intent);

    expect(adapter.measure).toHaveBeenCalledWith(intent);
    expect(result.measurementProof).toEqual(
      expect.objectContaining({
        adapterId: adapterBinding.adapterId,
        adapterImplementationSha256: adapterBinding.implementationSha256,
        adapterProvenanceSha256: adapterBinding.provenanceSha256,
        authorityGraphSha256: authorityGraph.graphSha256,
      }),
    );
    expect(result.measurementProof.factEvidence).toHaveLength(4);
    expect(result.measurementProofSha256).toHaveLength(64);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
  });
});
