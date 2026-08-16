import {
  canonicalWireJsonSha256V1,
  compareUtf16CodeUnits,
  type CanonicalHashAuthorityV1,
} from './canonical-json';

export const ANALYTICS_METRIC_CATALOG_SCHEMA_VERSION = 'analytics-metric-catalog.v1' as const;
export const ANALYTICS_MEASUREMENT_EVIDENCE_SCHEMA_VERSION =
  'analytics-measurement-evidence.v1' as const;
export const ANALYTICS_METRIC_SECTION_AUTHORITY_SCHEMA_VERSION =
  'analytics-metric-section-authority.v1' as const;

export const ANALYTICS_METRIC_CATALOG_HASH_AUTHORITY_V1: CanonicalHashAuthorityV1 = Object.freeze({
  domain: 'aquaculture.analytics-metric-catalog',
  schemaVersion: 'analytics-metric-catalog/v1',
});

export type AnalyticsMetricSection = 'tenants' | 'users' | 'financial' | 'system' | 'usage';
export type AnalyticsMetricQualification = 'MEASURED' | 'UNAVAILABLE';
export type AnalyticsMetricUnavailableReason = 'AUTHORITY_NOT_INTEGRATED' | 'SOURCE_QUERY_REJECTED';

export interface AnalyticsMetricDefinitionV1 {
  readonly metricId: `${AnalyticsMetricSection}.${string}`;
  readonly section: AnalyticsMetricSection;
  readonly field: string;
  readonly valueKind:
    | 'NUMBER'
    | 'NUMBER_RECORD'
    | 'OBJECT_RECORD'
    | 'OBJECT_ARRAY'
    | 'NUMBER_ARRAY';
  readonly authorityId: string;
  readonly qualification: AnalyticsMetricQualification;
  readonly unavailableReason?: 'AUTHORITY_NOT_INTEGRATED';
}

export interface AnalyticsModuleUsageValueV1 {
  readonly activeUsers: number;
  readonly totalSessions: number;
  readonly avgSessionDuration: number;
}

export interface AnalyticsTopFeatureValueV1 {
  readonly feature: string;
  readonly usage: number;
}

const RAW_ANALYTICS_METRIC_CATALOG_V1 = [
  {
    metricId: 'tenants.total',
    section: 'tenants',
    field: 'total',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.active',
    section: 'tenants',
    field: 'active',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.inactive',
    section: 'tenants',
    field: 'inactive',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.trial',
    section: 'tenants',
    field: 'trial',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.suspended',
    section: 'tenants',
    field: 'suspended',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.newThisMonth',
    section: 'tenants',
    field: 'newThisMonth',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.churnedThisMonth',
    section: 'tenants',
    field: 'churnedThisMonth',
    valueKind: 'NUMBER',
    authorityId: 'tenant-lifecycle-transition-ledger-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'tenants.churnRate',
    section: 'tenants',
    field: 'churnRate',
    valueKind: 'NUMBER',
    authorityId: 'tenant-lifecycle-transition-ledger-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'tenants.growthRate',
    section: 'tenants',
    field: 'growthRate',
    valueKind: 'NUMBER',
    authorityId: 'tenant-lifecycle-transition-ledger-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'tenants.byPlan',
    section: 'tenants',
    field: 'byPlan',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'postgres.auth-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'tenants.byRegion',
    section: 'tenants',
    field: 'byRegion',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'tenant-region-attribute-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },

  {
    metricId: 'users.total',
    section: 'users',
    field: 'total',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.active',
    section: 'users',
    field: 'active',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.inactive',
    section: 'users',
    field: 'inactive',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.newThisMonth',
    section: 'users',
    field: 'newThisMonth',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.activeLastDay',
    section: 'users',
    field: 'activeLastDay',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.activeLastWeek',
    section: 'users',
    field: 'activeLastWeek',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.activeLastMonth',
    section: 'users',
    field: 'activeLastMonth',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.growthRate',
    section: 'users',
    field: 'growthRate',
    valueKind: 'NUMBER',
    authorityId: 'qualified-user-history-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'users.avgUsersPerTenant',
    section: 'users',
    field: 'avgUsersPerTenant',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users-tenants.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'users.byRole',
    section: 'users',
    field: 'byRole',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'postgres.auth-users.aggregate-v1',
    qualification: 'MEASURED',
  },

  {
    metricId: 'financial.mrr',
    section: 'financial',
    field: 'mrr',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-subscriptions.pricing-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.arr',
    section: 'financial',
    field: 'arr',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-subscriptions.pricing-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.arpu',
    section: 'financial',
    field: 'arpu',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-subscriptions.pricing-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.arppu',
    section: 'financial',
    field: 'arppu',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-subscriptions.pricing-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.ltv',
    section: 'financial',
    field: 'ltv',
    valueKind: 'NUMBER',
    authorityId: 'billing-customer-lifetime-facts-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'financial.totalRevenue',
    section: 'financial',
    field: 'totalRevenue',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-invoices.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.revenueThisMonth',
    section: 'financial',
    field: 'revenueThisMonth',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-invoices.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.revenueGrowthRate',
    section: 'financial',
    field: 'revenueGrowthRate',
    valueKind: 'NUMBER',
    authorityId: 'qualified-financial-history-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'financial.pendingPayments',
    section: 'financial',
    field: 'pendingPayments',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-invoices.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.overduePayments',
    section: 'financial',
    field: 'overduePayments',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-invoices.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.refunds',
    section: 'financial',
    field: 'refunds',
    valueKind: 'NUMBER',
    authorityId: 'postgres.billing-invoices.aggregate-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.byPlan',
    section: 'financial',
    field: 'byPlan',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'postgres.billing-subscriptions.pricing-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'financial.byCurrency',
    section: 'financial',
    field: 'byCurrency',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'billing-currency-facts-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },

  {
    metricId: 'system.totalStorageBytes',
    section: 'system',
    field: 'totalStorageBytes',
    valueKind: 'NUMBER',
    authorityId: 'infrastructure-storage-capacity-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.usedStorageBytes',
    section: 'system',
    field: 'usedStorageBytes',
    valueKind: 'NUMBER',
    authorityId: 'postgres.pg-database-size-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'system.storageUtilization',
    section: 'system',
    field: 'storageUtilization',
    valueKind: 'NUMBER',
    authorityId: 'infrastructure-storage-capacity-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.apiCallsToday',
    section: 'system',
    field: 'apiCallsToday',
    valueKind: 'NUMBER',
    authorityId: 'gateway-request-metrics-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.apiCallsThisMonth',
    section: 'system',
    field: 'apiCallsThisMonth',
    valueKind: 'NUMBER',
    authorityId: 'gateway-request-metrics-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.avgResponseTimeMs',
    section: 'system',
    field: 'avgResponseTimeMs',
    valueKind: 'NUMBER',
    authorityId: 'gateway-request-metrics-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.errorRate',
    section: 'system',
    field: 'errorRate',
    valueKind: 'NUMBER',
    authorityId: 'gateway-request-metrics-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.uptimePercent',
    section: 'system',
    field: 'uptimePercent',
    valueKind: 'NUMBER',
    authorityId: 'service-slo-burnrate-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'system.activeConnections',
    section: 'system',
    field: 'activeConnections',
    valueKind: 'NUMBER',
    authorityId: 'postgres.pg-stat-activity-v1',
    qualification: 'MEASURED',
  },
  {
    metricId: 'system.queuedJobs',
    section: 'system',
    field: 'queuedJobs',
    valueKind: 'NUMBER',
    authorityId: 'job-queue-depth-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },

  {
    metricId: 'usage.moduleUsage',
    section: 'usage',
    field: 'moduleUsage',
    valueKind: 'OBJECT_RECORD',
    authorityId: 'qualified-audit-usage-projection-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'usage.featureAdoption',
    section: 'usage',
    field: 'featureAdoption',
    valueKind: 'NUMBER_RECORD',
    authorityId: 'qualified-audit-usage-projection-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'usage.topFeatures',
    section: 'usage',
    field: 'topFeatures',
    valueKind: 'OBJECT_ARRAY',
    authorityId: 'qualified-audit-usage-projection-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'usage.peakHours',
    section: 'usage',
    field: 'peakHours',
    valueKind: 'NUMBER_ARRAY',
    authorityId: 'qualified-audit-usage-projection-v1',
    qualification: 'UNAVAILABLE',
    unavailableReason: 'AUTHORITY_NOT_INTEGRATED',
  },
  {
    metricId: 'usage.avgDailyActiveUsers',
    section: 'usage',
    field: 'avgDailyActiveUsers',
    valueKind: 'NUMBER',
    authorityId: 'postgres.auth-users.last-login-v1',
    qualification: 'MEASURED',
  },
] as const satisfies readonly AnalyticsMetricDefinitionV1[];

export const ANALYTICS_DASHBOARD_METRIC_CATALOG_V1: readonly AnalyticsMetricDefinitionV1[] =
  Object.freeze(
    RAW_ANALYTICS_METRIC_CATALOG_V1.map((definition) => Object.freeze({ ...definition })),
  );

type AnalyticsMetricCatalogEntryV1 = (typeof RAW_ANALYTICS_METRIC_CATALOG_V1)[number];

type AnalyticsMetricValueForKindV1<TKind extends AnalyticsMetricDefinitionV1['valueKind']> =
  TKind extends 'NUMBER'
    ? number
    : TKind extends 'NUMBER_RECORD'
      ? Readonly<Record<string, number>>
      : TKind extends 'OBJECT_RECORD'
        ? Readonly<Record<string, AnalyticsModuleUsageValueV1>>
        : TKind extends 'OBJECT_ARRAY'
          ? readonly AnalyticsTopFeatureValueV1[]
          : TKind extends 'NUMBER_ARRAY'
            ? readonly number[]
            : never;

type AnalyticsMetricEntriesForSectionV1<TSection extends AnalyticsMetricSection> = Extract<
  AnalyticsMetricCatalogEntryV1,
  { readonly section: TSection }
>;

export type AnalyticsMetricSectionValuesV1<TSection extends AnalyticsMetricSection> = Readonly<{
  [TDefinition in AnalyticsMetricEntriesForSectionV1<TSection> as TDefinition['field']]: AnalyticsMetricValueForKindV1<
    TDefinition['valueKind']
  > | null;
}>;

export const ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256 = canonicalWireJsonSha256V1(
  ANALYTICS_METRIC_CATALOG_HASH_AUTHORITY_V1,
  {
    schemaVersion: ANALYTICS_METRIC_CATALOG_SCHEMA_VERSION,
    metrics: ANALYTICS_DASHBOARD_METRIC_CATALOG_V1,
  },
);

export interface AnalyticsMeasurementEvidenceV1 {
  readonly schemaVersion: typeof ANALYTICS_MEASUREMENT_EVIDENCE_SCHEMA_VERSION;
  readonly metricId: string;
  readonly state: AnalyticsMetricQualification;
  readonly authorityId: string;
  readonly asOf: string;
  readonly reason?: AnalyticsMetricUnavailableReason;
}

export type AnalyticsMeasurementEvidenceMapV1 = Readonly<
  Record<string, AnalyticsMeasurementEvidenceV1>
>;

export interface AnalyticsMetricSectionAuthorityV1 {
  readonly schemaVersion: typeof ANALYTICS_METRIC_SECTION_AUTHORITY_SCHEMA_VERSION;
  readonly metricCatalogSha256: typeof ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256;
  readonly measurementEvidence: AnalyticsMeasurementEvidenceMapV1;
}

export type AnalyticsMetricSectionProjectionV1<TSection extends AnalyticsMetricSection> =
  AnalyticsMetricSectionValuesV1<TSection> &
    Readonly<{
      authority: AnalyticsMetricSectionAuthorityV1;
    }>;

export function analyticsMetricDefinitionsForSectionV1(
  section: AnalyticsMetricSection,
): readonly AnalyticsMetricDefinitionV1[] {
  return ANALYTICS_DASHBOARD_METRIC_CATALOG_V1.filter(
    (definition) => definition.section === section,
  );
}

export function compileAnalyticsMeasurementEvidenceV1(
  section: AnalyticsMetricSection,
  asOf: string,
  sourceRejected = false,
): AnalyticsMeasurementEvidenceMapV1 {
  if (Number.isNaN(Date.parse(asOf))) {
    throw new TypeError('Analytics measurement evidence requires an ISO timestamp');
  }
  const entries = analyticsMetricDefinitionsForSectionV1(section).map((definition) => {
    const state = sourceRejected ? 'UNAVAILABLE' : definition.qualification;
    const reason = sourceRejected ? 'SOURCE_QUERY_REJECTED' : definition.unavailableReason;
    return [
      definition.field,
      Object.freeze({
        schemaVersion: ANALYTICS_MEASUREMENT_EVIDENCE_SCHEMA_VERSION,
        metricId: definition.metricId,
        state,
        authorityId: definition.authorityId,
        asOf,
        ...(reason === undefined ? {} : { reason }),
      }),
    ] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function assertAnalyticsMetricFieldSetV1(
  section: AnalyticsMetricSection,
  metric: Readonly<Record<string, unknown>>,
): void {
  const expected = analyticsMetricDefinitionsForSectionV1(section)
    .map((definition) => definition.field)
    .sort(compareUtf16CodeUnits);
  const actual = Object.keys(metric)
    .filter((field) => field !== 'authority')
    .sort(compareUtf16CodeUnits);
  if (
    expected.length !== actual.length ||
    expected.some((field, index) => field !== actual[index])
  ) {
    throw new TypeError(
      `Analytics ${section} metric fields diverge from catalog: expected=${expected.join(',')} actual=${actual.join(',')}`,
    );
  }
}

export function createAnalyticsMetricSectionProjectionV1<TSection extends AnalyticsMetricSection>(
  section: TSection,
  values: AnalyticsMetricSectionValuesV1<TSection>,
  asOf: string,
  sourceRejected = false,
): AnalyticsMetricSectionProjectionV1<TSection> {
  assertAnalyticsMetricFieldSetV1(section, values);
  for (const definition of analyticsMetricDefinitionsForSectionV1(section)) {
    const value = (values as Readonly<Record<string, unknown>>)[definition.field];
    if (sourceRejected) {
      if (value !== null) {
        throw new TypeError(
          `Rejected analytics source must project null for ${definition.metricId}`,
        );
      }
    } else if (definition.qualification === 'MEASURED' && value === null) {
      throw new TypeError(`Measured analytics metric cannot be null: ${definition.metricId}`);
    } else if (definition.qualification === 'UNAVAILABLE' && value !== null) {
      throw new TypeError(`Unavailable analytics metric must be null: ${definition.metricId}`);
    }
  }
  return Object.freeze({
    ...values,
    authority: Object.freeze({
      schemaVersion: ANALYTICS_METRIC_SECTION_AUTHORITY_SCHEMA_VERSION,
      metricCatalogSha256: ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
      measurementEvidence: compileAnalyticsMeasurementEvidenceV1(section, asOf, sourceRejected),
    }),
  }) as unknown as AnalyticsMetricSectionProjectionV1<TSection>;
}

export function createUnavailableAnalyticsMetricSectionProjectionV1<
  TSection extends AnalyticsMetricSection,
>(section: TSection, asOf: string): AnalyticsMetricSectionProjectionV1<TSection> {
  const values = Object.fromEntries(
    analyticsMetricDefinitionsForSectionV1(section).map((definition) => [definition.field, null]),
  ) as AnalyticsMetricSectionValuesV1<TSection>;
  return createAnalyticsMetricSectionProjectionV1(section, values, asOf, true);
}

export function analyticsMetricSectionProjectionHasValidEvidenceV1(
  section: AnalyticsMetricSection,
  projection: Readonly<Record<string, unknown>>,
): boolean {
  try {
    assertAnalyticsMetricFieldSetV1(section, projection);
  } catch {
    return false;
  }
  const authority = projection.authority;
  if (typeof authority !== 'object' || authority === null || Array.isArray(authority)) {
    return false;
  }
  const authorityRecord = authority as Readonly<Record<string, unknown>>;
  if (
    authorityRecord.schemaVersion !== ANALYTICS_METRIC_SECTION_AUTHORITY_SCHEMA_VERSION ||
    authorityRecord.metricCatalogSha256 !== ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256
  ) {
    return false;
  }
  const evidenceMap = authorityRecord.measurementEvidence;
  if (typeof evidenceMap !== 'object' || evidenceMap === null || Array.isArray(evidenceMap)) {
    return false;
  }
  const evidenceRecord = evidenceMap as Readonly<Record<string, unknown>>;
  const definitions = analyticsMetricDefinitionsForSectionV1(section);
  const expectedFields = definitions.map(({ field }) => field).sort(compareUtf16CodeUnits);
  const evidenceFields = Object.keys(evidenceRecord).sort(compareUtf16CodeUnits);
  if (
    expectedFields.length !== evidenceFields.length ||
    expectedFields.some((field, index) => field !== evidenceFields[index])
  ) {
    return false;
  }

  let sectionAsOf: string | undefined;
  for (const definition of definitions) {
    const evidence = evidenceRecord[definition.field];
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return false;
    const record = evidence as Readonly<Record<string, unknown>>;
    if (
      record.schemaVersion !== ANALYTICS_MEASUREMENT_EVIDENCE_SCHEMA_VERSION ||
      record.metricId !== definition.metricId ||
      record.authorityId !== definition.authorityId ||
      typeof record.asOf !== 'string' ||
      Number.isNaN(Date.parse(record.asOf))
    ) {
      return false;
    }
    if (sectionAsOf === undefined) sectionAsOf = record.asOf;
    if (record.asOf !== sectionAsOf) return false;

    const value = projection[definition.field];
    if (record.state === 'MEASURED') {
      if (
        definition.qualification !== 'MEASURED' ||
        value === null ||
        record.reason !== undefined
      ) {
        return false;
      }
    } else if (record.state === 'UNAVAILABLE') {
      if (value !== null) return false;
      const expectedReason =
        definition.qualification === 'UNAVAILABLE'
          ? definition.unavailableReason
          : 'SOURCE_QUERY_REJECTED';
      if (record.reason !== expectedReason && record.reason !== 'SOURCE_QUERY_REJECTED') {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}
