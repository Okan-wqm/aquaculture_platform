import {
  COMPILED_REPORT_AUTHORITY_GRAPH,
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_CAPABILITY_CATALOG,
  REPORT_FORMATS,
  REPORT_MAX_ARTIFACT_BYTES,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG,
  REPORT_TYPES,
  ReportAuthorityCatalogError,
  assertReportArtifactSize,
  assertReportArtifactCommitTransition,
  compileReportDatasetSnapshot,
  compileReportMeasurementIntent,
  compileReportAuthorityGraph,
  getReportCapability,
  getReportMeasurementAuthority,
  reportAuthorityGraphCanonicalJson,
  reportMeasurementIntentSha256,
  reportPreviewSha256,
} from './index';

describe('report authority catalogs', () => {
  it('compiles one exact measurement authority per capability deterministically', () => {
    const first = compileReportAuthorityGraph(
      REPORT_CAPABILITY_CATALOG,
      REPORT_MEASUREMENT_AUTHORITY_CATALOG,
    );
    const second = compileReportAuthorityGraph(
      REPORT_CAPABILITY_CATALOG,
      REPORT_MEASUREMENT_AUTHORITY_CATALOG,
    );

    expect(first).toEqual(second);
    expect(first.graphSha256).toBe(REPORT_AUTHORITY_GRAPH_SHA256);
    expect(reportAuthorityGraphCanonicalJson()).toBe(reportAuthorityGraphCanonicalJson());
    expect(first.capabilityCatalog.entries.map((entry) => entry.reportType)).toEqual(REPORT_TYPES);
    expect(first.measurementCatalog.entries.map((entry) => entry.reportType)).toEqual(REPORT_TYPES);
  });

  it('keeps every unqualified synthetic report fail-closed', () => {
    for (const reportType of REPORT_TYPES) {
      const capability = getReportCapability(reportType);
      const authority = getReportMeasurementAuthority(reportType);
      expect(capability.measurementAuthorityId).toBe(authority.authorityId);
      expect(authority.state).toBe('BLOCKED');
      expect(authority.blocker).not.toBeNull();
      expect(capability.artifact.policy).toBe('MEASUREMENT_QUALIFIED_ONLY');
      expect(capability.artifact.formats).toEqual(REPORT_FORMATS);
    }
  });

  it('rejects a broken capability-to-measurement edge', () => {
    const broken = {
      ...REPORT_CAPABILITY_CATALOG,
      entries: REPORT_CAPABILITY_CATALOG.entries.map((entry, index) =>
        index === 0 ? { ...entry, measurementAuthorityId: 'missing-authority.v1' } : entry,
      ),
    };

    expect(() => compileReportAuthorityGraph(broken, REPORT_MEASUREMENT_AUTHORITY_CATALOG)).toThrow(
      ReportAuthorityCatalogError,
    );
  });

  it('rejects additive fields instead of silently evolving the V1 schema', () => {
    const invalid = {
      ...REPORT_CAPABILITY_CATALOG,
      unexpectedDefault: 'generate-anyway',
    };

    expect(() =>
      compileReportAuthorityGraph(invalid, REPORT_MEASUREMENT_AUTHORITY_CATALOG),
    ).toThrow('capability catalog has a non-V1 shape');
  });

  it('snapshots mutable compiler input so its digest cannot become stale', () => {
    const entries = REPORT_CAPABILITY_CATALOG.entries.map((entry) => ({
      ...entry,
      preview: { ...entry.preview },
      artifact: { ...entry.artifact, formats: [...entry.artifact.formats] },
    }));
    const compiled = compileReportAuthorityGraph(
      { schemaVersion: 'report-capability-catalog.v1', entries },
      REPORT_MEASUREMENT_AUTHORITY_CATALOG,
    );

    entries[0]!.name = 'mutated after compilation';
    expect(compiled.capabilityCatalog.entries[0]?.name).toBe('Tenant Overview');
    expect(Object.isFrozen(compiled.capabilityCatalog.entries[0])).toBe(true);
  });

  it('rejects a qualified authority that still carries a blocker', () => {
    const invalid = {
      ...REPORT_MEASUREMENT_AUTHORITY_CATALOG,
      entries: REPORT_MEASUREMENT_AUTHORITY_CATALOG.entries.map((entry, index) =>
        index === 0 ? { ...entry, state: 'QUALIFIED' as const } : entry,
      ),
    };

    expect(() => compileReportAuthorityGraph(REPORT_CAPABILITY_CATALOG, invalid)).toThrow(
      'cannot be QUALIFIED with an active blocker',
    );
  });

  it('requires QUALIFIED measurement to bind exact adapter provenance', () => {
    const missingAdapter = {
      ...REPORT_MEASUREMENT_AUTHORITY_CATALOG,
      entries: REPORT_MEASUREMENT_AUTHORITY_CATALOG.entries.map((entry, index) =>
        index === 0 ? { ...entry, state: 'QUALIFIED' as const, blocker: null } : entry,
      ),
    };
    expect(() => compileReportAuthorityGraph(REPORT_CAPABILITY_CATALOG, missingAdapter)).toThrow(
      'must bind an exact qualified adapter',
    );

    const qualified = {
      ...missingAdapter,
      entries: missingAdapter.entries.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              qualifiedAdapter: {
                adapterId: 'tenant-overview-adapter.v1',
                implementationSha256: 'a'.repeat(64),
                provenanceSha256: 'b'.repeat(64),
              },
            }
          : entry,
      ),
    };
    expect(() => compileReportAuthorityGraph(REPORT_CAPABILITY_CATALOG, qualified)).not.toThrow();
  });

  it('content-addresses bounded previews with their full row count', () => {
    const rows = [{ id: 'tenant-1', status: 'active' }];
    expect(reportPreviewSha256('tenant_overview', 3, rows)).toHaveLength(64);
    expect(reportPreviewSha256('tenant_overview', 3, rows)).not.toBe(
      reportPreviewSha256('tenant_overview', 4, rows),
    );
    expect(() => reportPreviewSha256('tenant_overview', 0, rows)).toThrow(
      ReportAuthorityCatalogError,
    );
  });

  it('enforces the catalog artifact bound from one numeric authority', () => {
    expect(() =>
      assertReportArtifactSize('tenant_overview', REPORT_MAX_ARTIFACT_BYTES),
    ).not.toThrow();
    expect(() =>
      assertReportArtifactSize('tenant_overview', REPORT_MAX_ARTIFACT_BYTES + 1),
    ).toThrow(`between 0 and ${REPORT_MAX_ARTIFACT_BYTES}`);
  });

  it('rejects every artifact commit state skip', () => {
    expect(() => assertReportArtifactCommitTransition(null, 'INTENT_CREATED')).not.toThrow();
    expect(() =>
      assertReportArtifactCommitTransition('INTENT_CREATED', 'BYTES_VERIFIED'),
    ).not.toThrow();
    expect(() =>
      assertReportArtifactCommitTransition('BYTES_VERIFIED', 'REFERENCE_COMMITTED'),
    ).not.toThrow();
    expect(() => assertReportArtifactCommitTransition(null, 'REFERENCE_COMMITTED')).toThrow(
      'illegal report artifact commit transition',
    );
    expect(() =>
      assertReportArtifactCommitTransition('INTENT_CREATED', 'REFERENCE_COMMITTED'),
    ).toThrow('illegal report artifact commit transition');
  });

  it('materializes one frozen portable dataset snapshot without invoking accessors', () => {
    const accessorRow = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: jest.fn(() => 'forbidden'),
    });
    expect(() => compileReportDatasetSnapshot({ rows: [accessorRow], summary: {} })).toThrow(
      'must be an enumerable data property',
    );
    expect(Object.getOwnPropertyDescriptor(accessorRow, 'value')?.get).not.toHaveBeenCalled();

    const source = { nested: { value: 1 } };
    const snapshot = compileReportDatasetSnapshot({
      rows: [source],
      summary: { count: 1 },
    });
    source.nested.value = 2;
    expect(snapshot.rows[0]).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0]?.nested)).toBe(true);
  });

  it('rejects non-portable report values instead of silently coercing them', () => {
    expect(() =>
      compileReportDatasetSnapshot({
        rows: [{ value: Number.NaN }],
        summary: {},
      }),
    ).toThrow('non-finite number');
    expect(() =>
      compileReportDatasetSnapshot({
        rows: [{ value: undefined }],
        summary: {},
      }),
    ).toThrow('non-JSON value');
  });

  it('compiles one canonical, bounded half-open measurement intent', () => {
    const filters = { plans: ['professional'] };
    const intent = compileReportMeasurementIntent({
      reportType: 'financial_revenue',
      startInclusiveUtc: '2026-08-01T00:00:00.000Z',
      endExclusiveUtc: '2026-08-08T00:00:00.000Z',
      filters,
      currentTimeUtc: '2026-08-08T12:00:00.000Z',
    });
    filters.plans.push('enterprise');
    expect(intent.filters).toEqual({ plans: ['professional'] });
    expect(intent.intentSha256).toBe(
      reportMeasurementIntentSha256({
        reportType: intent.reportType,
        startInclusiveUtc: intent.startInclusiveUtc,
        endExclusiveUtc: intent.endExclusiveUtc,
        filters: intent.filters,
      }),
    );
    expect(Object.isFrozen(intent.filters?.plans)).toBe(true);

    expect(() =>
      compileReportMeasurementIntent({
        reportType: 'financial_revenue',
        startInclusiveUtc: '2026-08-08T00:00:00.000Z',
        endExclusiveUtc: '2026-08-08T00:00:00.000Z',
        filters: null,
        currentTimeUtc: '2026-08-08T12:00:00.000Z',
      }),
    ).toThrow('non-empty UTC half-open interval');
  });
});
