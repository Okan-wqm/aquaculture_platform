import {
  ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
  ANALYTICS_DASHBOARD_METRIC_CATALOG_V1,
  analyticsMetricDefinitionsForSectionV1,
  analyticsMetricSectionProjectionHasValidEvidenceV1,
  assertAnalyticsMetricFieldSetV1,
  compileAnalyticsMeasurementEvidenceV1,
  createAnalyticsMetricSectionProjectionV1,
  createUnavailableAnalyticsMetricSectionProjectionV1,
} from '../analytics-metric-catalog';

describe('analytics metric catalog SSOT', () => {
  it('has unique metric identities and section fields', () => {
    const metricIds = ANALYTICS_DASHBOARD_METRIC_CATALOG_V1.map(({ metricId }) => metricId);
    const sectionFields = ANALYTICS_DASHBOARD_METRIC_CATALOG_V1.map(
      ({ section, field }) => `${section}.${field}`,
    );

    expect(new Set(metricIds).size).toBe(metricIds.length);
    expect(new Set(sectionFields).size).toBe(sectionFields.length);
    expect(ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('compiles evidence for every exact field and marks rejected sources unavailable', () => {
    const asOf = '2026-08-09T12:00:00.000Z';
    const evidence = compileAnalyticsMeasurementEvidenceV1('tenants', asOf, true);
    const fields = analyticsMetricDefinitionsForSectionV1('tenants').map(({ field }) => field);

    expect(Object.keys(evidence).sort()).toEqual([...fields].sort());
    expect(Object.values(evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'UNAVAILABLE',
          reason: 'SOURCE_QUERY_REJECTED',
          asOf,
        }),
      ]),
    );
  });

  it('rejects field drift and creates catalog-bound projections', () => {
    const asOf = '2026-08-09T12:00:00.000Z';
    const unavailable = createUnavailableAnalyticsMetricSectionProjectionV1('system', asOf);

    expect(unavailable.authority.metricCatalogSha256).toBe(
      ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
    );
    expect(unavailable.usedStorageBytes).toBeNull();
    expect(unavailable.authority.measurementEvidence.usedStorageBytes).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'SOURCE_QUERY_REJECTED',
    });
    expect(analyticsMetricSectionProjectionHasValidEvidenceV1('system', unavailable)).toBe(true);

    expect(() => assertAnalyticsMetricFieldSetV1('system', { usedStorageBytes: 12 })).toThrow(
      /diverge from catalog/u,
    );

    const values = Object.fromEntries(
      analyticsMetricDefinitionsForSectionV1('usage').map(({ field }) => [
        field,
        field === 'avgDailyActiveUsers' ? 12 : null,
      ]),
    ) as Parameters<typeof createAnalyticsMetricSectionProjectionV1<'usage'>>[1];
    expect(createAnalyticsMetricSectionProjectionV1('usage', values, asOf)).toMatchObject({
      authority: {
        metricCatalogSha256: ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
      },
    });
  });
});
