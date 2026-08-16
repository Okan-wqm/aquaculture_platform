import {
  ANALYTICS_DASHBOARD_METRIC_CATALOG_V1,
  type AnalyticsMetricSection,
} from '@aquaculture/shared-contracts';

import {
  analyticsAnalyticsSnapshotContract,
  analyticsDashboardSummaryContract,
  analyticsFinancialMetricsContract,
  analyticsSystemMetricsContract,
  analyticsTenantMetricsContract,
  analyticsUsageMetricsContract,
  analyticsUserMetricsContract,
} from './admin-http-response.contract';

const contractsBySection = {
  tenants: analyticsTenantMetricsContract,
  users: analyticsUserMetricsContract,
  financial: analyticsFinancialMetricsContract,
  system: analyticsSystemMetricsContract,
  usage: analyticsUsageMetricsContract,
} as const;

describe('analytics response contract catalog parity', () => {
  it.each(Object.keys(contractsBySection) as AnalyticsMetricSection[])(
    'keeps the %s response field set equal to the catalog',
    (section) => {
      const catalogFields = ANALYTICS_DASHBOARD_METRIC_CATALOG_V1.filter(
        (definition) => definition.section === section,
      )
        .map((definition) => definition.field)
        .sort();
      const contractFields = Object.keys(contractsBySection[section].fields)
        .filter((field) => field !== 'authority')
        .sort();

      expect(contractFields).toEqual(catalogFields);
    },
  );

  it('reuses the same section contracts in dashboard and snapshot projections', () => {
    expect(analyticsDashboardSummaryContract.fields.tenants).toBe(analyticsTenantMetricsContract);
    expect(analyticsDashboardSummaryContract.fields.users).toBe(analyticsUserMetricsContract);
    expect(analyticsDashboardSummaryContract.fields.financial).toBe(
      analyticsFinancialMetricsContract,
    );
    expect(analyticsDashboardSummaryContract.fields.system).toBe(analyticsSystemMetricsContract);
    expect(analyticsDashboardSummaryContract.fields.usage).toBe(analyticsUsageMetricsContract);

    const snapshotVariants = analyticsAnalyticsSnapshotContract.fields.metrics.variants;
    expect(snapshotVariants).toEqual([
      analyticsTenantMetricsContract,
      analyticsUserMetricsContract,
      analyticsFinancialMetricsContract,
      analyticsSystemMetricsContract,
      analyticsUsageMetricsContract,
    ]);
  });
});
