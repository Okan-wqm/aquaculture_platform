import {
  adminManualResponse,
  adminResponse,
  type AdminResponseProjection,
} from '@platform/admin-http-contracts';
import {
  REPORT_FORMATS,
  REPORT_ARTIFACT_COMMIT_STATES,
  REPORT_MAX_ARTIFACT_BYTES,
  REPORT_MEASUREMENT_STATES,
  REPORT_RANGE_POLICIES,
  REPORT_SCHEDULE_POLICIES,
  REPORT_TYPES,
} from '@platform/reporting-contracts';

export const reportsArtifactDownloadProfile = adminManualResponse.binary(
  [200],
  ['application/json', 'application/pdf', 'text/csv'],
  REPORT_MAX_ARTIFACT_BYTES,
);

export const analyticsMeasurementEvidenceContract = adminResponse.object({
  schemaVersion: adminResponse.literal('analytics-measurement-evidence.v1'),
  metricId: adminResponse.string(),
  state: adminResponse.union([
    adminResponse.literal('MEASURED'),
    adminResponse.literal('UNAVAILABLE'),
  ] as const),
  authorityId: adminResponse.string(),
  asOf: adminResponse.dateString(),
  reason: adminResponse.optional(
    adminResponse.union([
      adminResponse.literal('AUTHORITY_NOT_INTEGRATED'),
      adminResponse.literal('SOURCE_QUERY_REJECTED'),
    ] as const),
  ),
});

export const analyticsMetricSectionAuthorityContract = adminResponse.object({
  schemaVersion: adminResponse.literal('analytics-metric-section-authority.v1'),
  metricCatalogSha256: adminResponse.string(),
  measurementEvidence: adminResponse.record(analyticsMeasurementEvidenceContract),
});

export const analyticsTenantMetricsContract = adminResponse.object({
  total: adminResponse.nullable(adminResponse.number()),
  active: adminResponse.nullable(adminResponse.number()),
  inactive: adminResponse.nullable(adminResponse.number()),
  trial: adminResponse.nullable(adminResponse.number()),
  suspended: adminResponse.nullable(adminResponse.number()),
  newThisMonth: adminResponse.nullable(adminResponse.number()),
  churnedThisMonth: adminResponse.nullable(adminResponse.number()),
  churnRate: adminResponse.nullable(adminResponse.number()),
  growthRate: adminResponse.nullable(adminResponse.number()),
  byPlan: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  byRegion: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  authority: analyticsMetricSectionAuthorityContract,
});

export const analyticsUserMetricsContract = adminResponse.object({
  total: adminResponse.nullable(adminResponse.number()),
  active: adminResponse.nullable(adminResponse.number()),
  inactive: adminResponse.nullable(adminResponse.number()),
  newThisMonth: adminResponse.nullable(adminResponse.number()),
  activeLastDay: adminResponse.nullable(adminResponse.number()),
  activeLastWeek: adminResponse.nullable(adminResponse.number()),
  activeLastMonth: adminResponse.nullable(adminResponse.number()),
  growthRate: adminResponse.nullable(adminResponse.number()),
  avgUsersPerTenant: adminResponse.nullable(adminResponse.number()),
  byRole: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  authority: analyticsMetricSectionAuthorityContract,
});

export const analyticsFinancialMetricsContract = adminResponse.object({
  mrr: adminResponse.nullable(adminResponse.number()),
  arr: adminResponse.nullable(adminResponse.number()),
  arpu: adminResponse.nullable(adminResponse.number()),
  arppu: adminResponse.nullable(adminResponse.number()),
  ltv: adminResponse.nullable(adminResponse.number()),
  totalRevenue: adminResponse.nullable(adminResponse.number()),
  revenueThisMonth: adminResponse.nullable(adminResponse.number()),
  revenueGrowthRate: adminResponse.nullable(adminResponse.number()),
  pendingPayments: adminResponse.nullable(adminResponse.number()),
  overduePayments: adminResponse.nullable(adminResponse.number()),
  refunds: adminResponse.nullable(adminResponse.number()),
  byPlan: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  byCurrency: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  authority: analyticsMetricSectionAuthorityContract,
});

export const analyticsSystemMetricsContract = adminResponse.object({
  totalStorageBytes: adminResponse.nullable(adminResponse.number()),
  usedStorageBytes: adminResponse.nullable(adminResponse.number()),
  storageUtilization: adminResponse.nullable(adminResponse.number()),
  apiCallsToday: adminResponse.nullable(adminResponse.number()),
  apiCallsThisMonth: adminResponse.nullable(adminResponse.number()),
  avgResponseTimeMs: adminResponse.nullable(adminResponse.number()),
  errorRate: adminResponse.nullable(adminResponse.number()),
  uptimePercent: adminResponse.nullable(adminResponse.number()),
  activeConnections: adminResponse.nullable(adminResponse.number()),
  queuedJobs: adminResponse.nullable(adminResponse.number()),
  authority: analyticsMetricSectionAuthorityContract,
});

export const analyticsUsageMetricsContract = adminResponse.object({
  moduleUsage: adminResponse.nullable(
    adminResponse.record(
      adminResponse.object({
        activeUsers: adminResponse.number(),
        totalSessions: adminResponse.number(),
        avgSessionDuration: adminResponse.number(),
      }),
    ),
  ),
  featureAdoption: adminResponse.nullable(adminResponse.record(adminResponse.number())),
  topFeatures: adminResponse.nullable(
    adminResponse.array(
      adminResponse.object({
        feature: adminResponse.string(),
        usage: adminResponse.number(),
      }),
    ),
  ),
  peakHours: adminResponse.nullable(adminResponse.array(adminResponse.number())),
  avgDailyActiveUsers: adminResponse.nullable(adminResponse.number()),
  authority: analyticsMetricSectionAuthorityContract,
});

export const analyticsDashboardSummaryContract = adminResponse.object({
  tenants: analyticsTenantMetricsContract,
  users: analyticsUserMetricsContract,
  financial: analyticsFinancialMetricsContract,
  system: analyticsSystemMetricsContract,
  usage: analyticsUsageMetricsContract,
  generatedAt: adminResponse.dateString(),
  unavailable: adminResponse.optional(adminResponse.array(adminResponse.string())),
});

export type AnalyticsDashboardSummaryDto = AdminResponseProjection<
  typeof analyticsDashboardSummaryContract
>;

export const analyticsGetKpiComparisonsResponseContract = adminResponse.record(
  adminResponse.object({
    current: adminResponse.number(),
    previous: adminResponse.number(),
    change: adminResponse.number(),
    changePercent: adminResponse.nullable(adminResponse.number()),
    trend: adminResponse.union([
      adminResponse.literal('up'),
      adminResponse.literal('down'),
      adminResponse.literal('stable'),
      adminResponse.literal('unavailable'),
    ] as const),
  }),
);

export type AnalyticsGetKpiComparisonsResponseDto = AdminResponseProjection<
  typeof analyticsGetKpiComparisonsResponseContract
>;

export type AnalyticsTenantMetricsDto = AdminResponseProjection<
  typeof analyticsTenantMetricsContract
>;

export const analyticsSnapshotTrendResponseContract = adminResponse.object({
  range: adminResponse.union([
    adminResponse.literal('7d'),
    adminResponse.literal('30d'),
    adminResponse.literal('90d'),
    adminResponse.literal('1y'),
  ] as const),
  granularity: adminResponse.union([
    adminResponse.literal('day'),
    adminResponse.literal('week'),
    adminResponse.literal('month'),
  ] as const),
  data: adminResponse.array(
    adminResponse.object({
      date: adminResponse.string(),
      value: adminResponse.number(),
    }),
  ),
  source: adminResponse.string(),
  asOf: adminResponse.string(),
});

export type AnalyticsSnapshotTrendResponseDto = AdminResponseProjection<
  typeof analyticsSnapshotTrendResponseContract
>;

export const analyticsTimeSeriesDataContract = adminResponse.object({
  label: adminResponse.string(),
  data: adminResponse.array(
    adminResponse.object({
      date: adminResponse.string(),
      value: adminResponse.number(),
    }),
  ),
  color: adminResponse.optional(adminResponse.string()),
});

export type AnalyticsTimeSeriesDataDto = AdminResponseProjection<
  typeof analyticsTimeSeriesDataContract
>;

export type AnalyticsUserMetricsDto = AdminResponseProjection<typeof analyticsUserMetricsContract>;

export const analyticsChartDataContract = adminResponse.object({
  labels: adminResponse.array(adminResponse.string()),
  datasets: adminResponse.array(
    adminResponse.object({
      label: adminResponse.string(),
      data: adminResponse.array(adminResponse.number()),
      backgroundColor: adminResponse.optional(
        adminResponse.union([
          adminResponse.string(),
          adminResponse.array(adminResponse.string()),
        ] as const),
      ),
      borderColor: adminResponse.optional(adminResponse.string()),
    }),
  ),
});

export type AnalyticsChartDataDto = AdminResponseProjection<typeof analyticsChartDataContract>;

export type AnalyticsFinancialMetricsDto = AdminResponseProjection<
  typeof analyticsFinancialMetricsContract
>;

export const analyticsRevenueAnalyticsContract = adminResponse.object({
  totalRevenue: adminResponse.number(),
  mrr: adminResponse.number(),
  arr: adminResponse.number(),
  averageRevenuePerTenant: adminResponse.number(),
  revenueByPlan: adminResponse.array(
    adminResponse.object({
      plan: adminResponse.string(),
      revenue: adminResponse.number(),
      percentage: adminResponse.number(),
    }),
  ),
  revenueByMonth: adminResponse.array(
    adminResponse.object({
      month: adminResponse.string(),
      revenue: adminResponse.number(),
    }),
  ),
});

export type AnalyticsRevenueAnalyticsDto = AdminResponseProjection<
  typeof analyticsRevenueAnalyticsContract
>;

export const analyticsGetRevenueAnalyticsByPlanResponseContract = adminResponse.object({
  plan: adminResponse.string(),
  revenue: adminResponse.number(),
  tenantCount: adminResponse.number(),
});

export type AnalyticsGetRevenueAnalyticsByPlanResponseDto = AdminResponseProjection<
  typeof analyticsGetRevenueAnalyticsByPlanResponseContract
>;

export type AnalyticsSystemMetricsDto = AdminResponseProjection<
  typeof analyticsSystemMetricsContract
>;

export type AnalyticsUsageMetricsDto = AdminResponseProjection<
  typeof analyticsUsageMetricsContract
>;

export const analyticsAnalyticsSnapshotContract = adminResponse.object({
  id: adminResponse.string(),
  snapshotType: adminResponse.union([
    adminResponse.literal('daily'),
    adminResponse.literal('weekly'),
    adminResponse.literal('monthly'),
    adminResponse.literal('yearly'),
  ] as const),
  category: adminResponse.union([
    adminResponse.literal('tenant'),
    adminResponse.literal('user'),
    adminResponse.literal('financial'),
    adminResponse.literal('system'),
    adminResponse.literal('usage'),
  ] as const),
  snapshotDate: adminResponse.dateString(),
  metrics: adminResponse.union([
    analyticsTenantMetricsContract,
    analyticsUserMetricsContract,
    analyticsFinancialMetricsContract,
    analyticsSystemMetricsContract,
    analyticsUsageMetricsContract,
  ] as const),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
});

export type AnalyticsAnalyticsSnapshotDto = AdminResponseProjection<
  typeof analyticsAnalyticsSnapshotContract
>;

export const reportsReportDefinitionDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  type: adminResponse.literalSet(REPORT_TYPES),
  defaultFormat: adminResponse.literalSet(REPORT_FORMATS),
  status: adminResponse.union([
    adminResponse.literal('active'),
    adminResponse.literal('inactive'),
    adminResponse.literal('draft'),
  ] as const),
  defaultFilters: adminResponse.optional(
    adminResponse.record(adminResponse.json('report-dataset')),
  ),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdByEmail: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ReportsReportDefinitionDtoDto = AdminResponseProjection<
  typeof reportsReportDefinitionDtoContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

const reportsReportFactEvidenceContract = adminResponse.object({
  factId: adminResponse.string(),
  sourceCutSha256: adminResponse.string(),
});

const reportsReportMeasurementProofContract = adminResponse.object({
  schemaVersion: adminResponse.literal('report-measurement-proof.v1'),
  reportType: adminResponse.literalSet(REPORT_TYPES),
  intentSha256: adminResponse.string(),
  capabilityCatalogSha256: adminResponse.string(),
  measurementCatalogSha256: adminResponse.string(),
  authorityGraphSha256: adminResponse.string(),
  measurementAuthorityId: adminResponse.string(),
  adapterId: adminResponse.string(),
  adapterImplementationSha256: adminResponse.string(),
  adapterProvenanceSha256: adminResponse.string(),
  measuredAt: adminResponse.dateString(),
  datasetSha256: adminResponse.string(),
  factEvidence: adminResponse.array(reportsReportFactEvidenceContract),
});

export const reportsReportExecutionDtoContract = adminResponse.object({
  id: adminResponse.string(),
  definitionId: adminResponse.optional(adminResponse.string()),
  reportName: adminResponse.string(),
  reportType: adminResponse.literalSet(REPORT_TYPES),
  format: adminResponse.literalSet(REPORT_FORMATS),
  status: adminResponse.union([
    adminResponse.literal('pending'),
    adminResponse.literal('running'),
    adminResponse.literal('completed'),
    adminResponse.literal('failed'),
    adminResponse.literal('unavailable'),
  ] as const),
  startDate: adminResponse.optional(adminResponse.dateString()),
  endDate: adminResponse.optional(adminResponse.dateString()),
  filters: adminResponse.optional(adminResponse.record(adminResponse.json('report-dataset'))),
  summary: adminResponse.optional(adminResponse.record(adminResponse.json('report-dataset'))),
  rowCount: adminResponse.optional(adminResponse.number()),
  fileSizeBytes: adminResponse.optional(adminResponse.number()),
  artifactObjectKey: adminResponse.optional(adminResponse.string()),
  artifactSha256: adminResponse.optional(adminResponse.string()),
  artifactContentType: adminResponse.optional(adminResponse.string()),
  downloadExpiresAt: adminResponse.optional(adminResponse.dateString()),
  previewRows: adminResponse.optional(
    adminResponse.array(adminResponse.record(adminResponse.json('report-dataset'))),
  ),
  previewSha256: adminResponse.optional(adminResponse.string()),
  measurementProof: adminResponse.optional(reportsReportMeasurementProofContract),
  measurementProofSha256: adminResponse.optional(adminResponse.string()),
  stagedArtifactObjectKey: adminResponse.optional(adminResponse.string()),
  stagedArtifactSha256: adminResponse.optional(adminResponse.string()),
  artifactCommitState: adminResponse.optional(
    adminResponse.literalSet(REPORT_ARTIFACT_COMMIT_STATES),
  ),
  capabilityCatalogSha256: adminResponse.string(),
  measurementCatalogSha256: adminResponse.string(),
  authorityGraphSha256: adminResponse.string(),
  artifactMaximumBytes: adminResponse.number(),
  previewMaximumRows: adminResponse.number(),
  measurementState: adminResponse.literalSet(REPORT_MEASUREMENT_STATES),
  errorMessage: adminResponse.optional(adminResponse.string()),
  durationMs: adminResponse.optional(adminResponse.number()),
  executedBy: adminResponse.optional(adminResponse.string()),
  executedByEmail: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  completedAt: adminResponse.optional(adminResponse.dateString()),
});

export type ReportsReportExecutionDtoDto = AdminResponseProjection<
  typeof reportsReportExecutionDtoContract
>;

export const reportsReportCapabilityDtoContract = adminResponse.object({
  type: adminResponse.literalSet(REPORT_TYPES),
  name: adminResponse.string(),
  description: adminResponse.string(),
  category: adminResponse.string(),
  rangePolicy: adminResponse.literalSet(REPORT_RANGE_POLICIES),
  schedulePolicy: adminResponse.literalSet(REPORT_SCHEDULE_POLICIES),
  previewMaximumRows: adminResponse.number(),
  artifactMaximumBytes: adminResponse.number(),
  measurementState: adminResponse.literalSet(REPORT_MEASUREMENT_STATES),
  unavailableReason: adminResponse.optional(adminResponse.string()),
  capabilityCatalogSha256: adminResponse.string(),
  measurementCatalogSha256: adminResponse.string(),
  authorityGraphSha256: adminResponse.string(),
});

export type ReportsReportCapabilityDto = AdminResponseProjection<
  typeof reportsReportCapabilityDtoContract
>;

export const analyticsAnalyticsSnapshotArrayContract = adminResponse.array(
  analyticsAnalyticsSnapshotContract,
);

export const analyticsGetRevenueAnalyticsByPlanResponseArrayContract = adminResponse.array(
  analyticsGetRevenueAnalyticsByPlanResponseContract,
);

export const reportsReportCapabilityDtoArrayContract = adminResponse.array(
  reportsReportCapabilityDtoContract,
);

export const reportsReportDefinitionDtoPageContract = adminResponse.page(
  reportsReportDefinitionDtoContract,
);

export const reportsReportExecutionDtoPageContract = adminResponse.page(
  reportsReportExecutionDtoContract,
);
