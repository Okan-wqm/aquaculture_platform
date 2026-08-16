import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';
import { ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION } from '@aquaculture/shared-contracts';

export const debugToolsDebugDashboardContract = adminResponse.object({
  activeSessions: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      adminId: adminResponse.string(),
      tenantId: adminResponse.string(),
      sessionType: adminResponse.union([
        adminResponse.literal('query_inspection'),
        adminResponse.literal('api_log_viewing'),
        adminResponse.literal('cache_inspection'),
        adminResponse.literal('feature_flag_override'),
        adminResponse.literal('performance_profiling'),
        adminResponse.literal('error_debugging'),
      ] as const),
      isActive: adminResponse.boolean(),
      configuration: adminResponse.optional(
        adminResponse.record(adminResponse.json('debug-observation')),
      ),
      filters: adminResponse.optional(
        adminResponse.object({
          startTime: adminResponse.optional(adminResponse.dateString()),
          endTime: adminResponse.optional(adminResponse.dateString()),
          queryTypes: adminResponse.optional(
            adminResponse.array(
              adminResponse.union([
                adminResponse.literal('select'),
                adminResponse.literal('insert'),
                adminResponse.literal('update'),
                adminResponse.literal('delete'),
                adminResponse.literal('transaction'),
                adminResponse.literal('schema'),
              ] as const),
            ),
          ),
          apiEndpoints: adminResponse.optional(adminResponse.array(adminResponse.string())),
          cacheKeys: adminResponse.optional(adminResponse.array(adminResponse.string())),
          minDuration: adminResponse.optional(adminResponse.number()),
          includeErrors: adminResponse.optional(
            adminResponse.union([
              adminResponse.literal(false),
              adminResponse.literal(true),
            ] as const),
          ),
          userId: adminResponse.optional(adminResponse.string()),
        }),
      ),
      maxResults: adminResponse.number(),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
    }),
  ),
  recentQueries: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      debugSessionId: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.string(),
      userId: adminResponse.optional(adminResponse.string()),
      queryType: adminResponse.union([
        adminResponse.literal('select'),
        adminResponse.literal('insert'),
        adminResponse.literal('update'),
        adminResponse.literal('delete'),
        adminResponse.literal('transaction'),
        adminResponse.literal('schema'),
      ] as const),
      query: adminResponse.string(),
      parameters: adminResponse.optional(
        adminResponse.array(adminResponse.json('debug-observation')),
      ),
      normalizedQuery: adminResponse.optional(adminResponse.string()),
      durationMs: adminResponse.number(),
      rowsAffected: adminResponse.optional(adminResponse.number()),
      rowsReturned: adminResponse.optional(adminResponse.number()),
      tableName: adminResponse.optional(adminResponse.string()),
      explainPlan: adminResponse.optional(
        adminResponse.record(adminResponse.json('debug-observation')),
      ),
      isSlowQuery: adminResponse.boolean(),
      hasError: adminResponse.boolean(),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      connectionSource: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  recentApiCalls: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      debugSessionId: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.string(),
      userId: adminResponse.optional(adminResponse.string()),
      method: adminResponse.string(),
      endpoint: adminResponse.string(),
      fullUrl: adminResponse.optional(adminResponse.string()),
      requestHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
      requestBody: adminResponse.optional(adminResponse.json('debug-observation')),
      queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
      responseStatus: adminResponse.number(),
      responseHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
      responseBody: adminResponse.optional(adminResponse.json('debug-observation')),
      durationMs: adminResponse.number(),
      clientIp: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      correlationId: adminResponse.optional(adminResponse.string()),
      hasError: adminResponse.boolean(),
      errorMessage: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  activeOverrides: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      featureKey: adminResponse.string(),
      originalValue: adminResponse.json('debug-observation'),
      overrideValue: adminResponse.json('debug-observation'),
      isActive: adminResponse.boolean(),
      adminId: adminResponse.string(),
      reason: adminResponse.optional(adminResponse.string()),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      appliedAt: adminResponse.optional(adminResponse.dateString()),
      revertedAt: adminResponse.optional(adminResponse.dateString()),
      revertedBy: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
    }),
  ),
  tenantStats: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      queryCount: adminResponse.number(),
      apiCallCount: adminResponse.number(),
      errorRate: adminResponse.number(),
    }),
  ),
});

export type DebugToolsDebugDashboardDto = AdminResponseProjection<
  typeof debugToolsDebugDashboardContract
>;

export const debugToolsDebugSessionContract = adminResponse.object({
  id: adminResponse.string(),
  adminId: adminResponse.string(),
  tenantId: adminResponse.string(),
  sessionType: adminResponse.union([
    adminResponse.literal('query_inspection'),
    adminResponse.literal('api_log_viewing'),
    adminResponse.literal('cache_inspection'),
    adminResponse.literal('feature_flag_override'),
    adminResponse.literal('performance_profiling'),
    adminResponse.literal('error_debugging'),
  ] as const),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  configuration: adminResponse.optional(
    adminResponse.record(adminResponse.json('debug-observation')),
  ),
  filters: adminResponse.optional(
    adminResponse.object({
      startTime: adminResponse.optional(adminResponse.dateString()),
      endTime: adminResponse.optional(adminResponse.dateString()),
      queryTypes: adminResponse.optional(
        adminResponse.array(
          adminResponse.union([
            adminResponse.literal('select'),
            adminResponse.literal('insert'),
            adminResponse.literal('update'),
            adminResponse.literal('delete'),
            adminResponse.literal('transaction'),
            adminResponse.literal('schema'),
          ] as const),
        ),
      ),
      apiEndpoints: adminResponse.optional(adminResponse.array(adminResponse.string())),
      cacheKeys: adminResponse.optional(adminResponse.array(adminResponse.string())),
      minDuration: adminResponse.optional(adminResponse.number()),
      includeErrors: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
      userId: adminResponse.optional(adminResponse.string()),
    }),
  ),
  maxResults: adminResponse.number(),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
});

export type DebugToolsDebugSessionDto = AdminResponseProjection<
  typeof debugToolsDebugSessionContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const debugToolsQueryInspectorResultContract = adminResponse.object({
  queries: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      debugSessionId: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.string(),
      userId: adminResponse.optional(adminResponse.string()),
      queryType: adminResponse.union([
        adminResponse.literal('select'),
        adminResponse.literal('insert'),
        adminResponse.literal('update'),
        adminResponse.literal('delete'),
        adminResponse.literal('transaction'),
        adminResponse.literal('schema'),
      ] as const),
      query: adminResponse.string(),
      parameters: adminResponse.optional(
        adminResponse.array(adminResponse.json('debug-observation')),
      ),
      normalizedQuery: adminResponse.optional(adminResponse.string()),
      durationMs: adminResponse.number(),
      rowsAffected: adminResponse.optional(adminResponse.number()),
      rowsReturned: adminResponse.optional(adminResponse.number()),
      tableName: adminResponse.optional(adminResponse.string()),
      explainPlan: adminResponse.optional(
        adminResponse.record(adminResponse.json('debug-observation')),
      ),
      isSlowQuery: adminResponse.boolean(),
      hasError: adminResponse.boolean(),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      connectionSource: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  summary: adminResponse.object({
    totalQueries: adminResponse.number(),
    totalDuration: adminResponse.number(),
    avgDuration: adminResponse.number(),
    slowQueries: adminResponse.number(),
    errorCount: adminResponse.number(),
    queryTypeBreakdown: adminResponse.object({
      select: adminResponse.number(),
      insert: adminResponse.number(),
      update: adminResponse.number(),
      delete: adminResponse.number(),
      transaction: adminResponse.number(),
      schema: adminResponse.number(),
    }),
  }),
});

export type DebugToolsQueryInspectorResultDto = AdminResponseProjection<
  typeof debugToolsQueryInspectorResultContract
>;

export const debugToolsGetQueryExplainPlanResponseContract = adminResponse.nullable(
  adminResponse.record(adminResponse.json('debug-observation')),
);

export type DebugToolsGetQueryExplainPlanResponseDto = AdminResponseProjection<
  typeof debugToolsGetQueryExplainPlanResponseContract
>;

export const debugToolsSlowQueryAnalysisContract = adminResponse.object({
  slowQueries: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      debugSessionId: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.string(),
      userId: adminResponse.optional(adminResponse.string()),
      queryType: adminResponse.union([
        adminResponse.literal('select'),
        adminResponse.literal('insert'),
        adminResponse.literal('update'),
        adminResponse.literal('delete'),
        adminResponse.literal('transaction'),
        adminResponse.literal('schema'),
      ] as const),
      query: adminResponse.string(),
      parameters: adminResponse.optional(
        adminResponse.array(adminResponse.json('debug-observation')),
      ),
      normalizedQuery: adminResponse.optional(adminResponse.string()),
      durationMs: adminResponse.number(),
      rowsAffected: adminResponse.optional(adminResponse.number()),
      rowsReturned: adminResponse.optional(adminResponse.number()),
      tableName: adminResponse.optional(adminResponse.string()),
      explainPlan: adminResponse.optional(
        adminResponse.record(adminResponse.json('debug-observation')),
      ),
      isSlowQuery: adminResponse.boolean(),
      hasError: adminResponse.boolean(),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      connectionSource: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  patterns: adminResponse.array(
    adminResponse.object({
      pattern: adminResponse.string(),
      count: adminResponse.number(),
      avgDuration: adminResponse.number(),
    }),
  ),
  recommendations: adminResponse.array(adminResponse.string()),
});

export type DebugToolsSlowQueryAnalysisDto = AdminResponseProjection<
  typeof debugToolsSlowQueryAnalysisContract
>;

export const debugToolsApiLogResultContract = adminResponse.object({
  calls: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      debugSessionId: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.string(),
      userId: adminResponse.optional(adminResponse.string()),
      method: adminResponse.string(),
      endpoint: adminResponse.string(),
      fullUrl: adminResponse.optional(adminResponse.string()),
      requestHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
      requestBody: adminResponse.optional(adminResponse.json('debug-observation')),
      queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
      responseStatus: adminResponse.number(),
      responseHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
      responseBody: adminResponse.optional(adminResponse.json('debug-observation')),
      durationMs: adminResponse.number(),
      clientIp: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      correlationId: adminResponse.optional(adminResponse.string()),
      hasError: adminResponse.boolean(),
      errorMessage: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  summary: adminResponse.object({
    totalCalls: adminResponse.number(),
    totalDuration: adminResponse.number(),
    avgDuration: adminResponse.number(),
    errorCount: adminResponse.number(),
    statusBreakdown: adminResponse.record(adminResponse.number()),
    endpointBreakdown: adminResponse.array(
      adminResponse.object({
        endpoint: adminResponse.string(),
        count: adminResponse.number(),
        avgDuration: adminResponse.number(),
      }),
    ),
  }),
});

export type DebugToolsApiLogResultDto = AdminResponseProjection<
  typeof debugToolsApiLogResultContract
>;

export const debugToolsApiUsageSummaryContract = adminResponse.object({
  totalCalls: adminResponse.number(),
  avgResponseTime: adminResponse.number(),
  errorRate: adminResponse.number(),
  topEndpoints: adminResponse.array(
    adminResponse.object({
      endpoint: adminResponse.string(),
      count: adminResponse.number(),
      avgDuration: adminResponse.number(),
    }),
  ),
  statusDistribution: adminResponse.record(adminResponse.number()),
});

export type DebugToolsApiUsageSummaryDto = AdminResponseProjection<
  typeof debugToolsApiUsageSummaryContract
>;

export const debugToolsCapturedApiCallContract = adminResponse.object({
  id: adminResponse.string(),
  debugSessionId: adminResponse.optional(adminResponse.string()),
  tenantId: adminResponse.string(),
  method: adminResponse.string(),
  endpoint: adminResponse.string(),
  fullUrl: adminResponse.optional(adminResponse.string()),
  requestHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
  requestBody: adminResponse.optional(adminResponse.json('debug-observation')),
  queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
  responseStatus: adminResponse.number(),
  responseHeaders: adminResponse.optional(adminResponse.record(adminResponse.string())),
  responseBody: adminResponse.optional(adminResponse.json('debug-observation')),
  durationMs: adminResponse.number(),
  hasError: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  errorMessage: adminResponse.optional(adminResponse.string()),
  timestamp: adminResponse.dateString(),
});

export type DebugToolsCapturedApiCallDto = AdminResponseProjection<
  typeof debugToolsCapturedApiCallContract
>;

export const debugToolsCacheStatsContract = adminResponse.object({
  namespace: adminResponse.string(),
  keysInNamespace: adminResponse.number(),
  instance: adminResponse.object({
    keyspaceHits: adminResponse.number(),
    keyspaceMisses: adminResponse.number(),
    hitRatePercent: adminResponse.nullable(adminResponse.number()),
    usedMemoryBytes: adminResponse.number(),
    totalKeys: adminResponse.number(),
  }),
});

export type DebugToolsCacheStatsDto = AdminResponseProjection<typeof debugToolsCacheStatsContract>;

const debugToolsCacheKeyEntryContract = adminResponse.object({
  key: adminResponse.string(),
  type: adminResponse.string(),
  ttlSeconds: adminResponse.number(),
  sizeBytes: adminResponse.nullable(adminResponse.number()),
  idleSeconds: adminResponse.nullable(adminResponse.number()),
});

export const debugToolsCacheNamespaceListingContract = adminResponse.object({
  namespace: adminResponse.string(),
  entries: adminResponse.array(debugToolsCacheKeyEntryContract),
  matchedCount: adminResponse.number(),
  truncated: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type DebugToolsCacheNamespaceListingDto = AdminResponseProjection<
  typeof debugToolsCacheNamespaceListingContract
>;

export const debugToolsCacheKeyValueContract = adminResponse.object({
  key: adminResponse.string(),
  type: adminResponse.string(),
  ttlSeconds: adminResponse.number(),
  sizeBytes: adminResponse.nullable(adminResponse.number()),
  value: adminResponse.nullable(adminResponse.string()),
});

export type DebugToolsCacheKeyValueDto = AdminResponseProjection<
  typeof debugToolsCacheKeyValueContract
>;

export const debugToolsCacheInvalidationReceiptContract = adminResponse.object({
  schemaVersion: adminResponse.literal(ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION),
  receiptId: adminResponse.string(),
  namespace: adminResponse.string(),
  selector: adminResponse.object({
    kind: adminResponse.union([
      adminResponse.literal('KEY'),
      adminResponse.literal('PATTERN'),
    ] as const),
    value: adminResponse.string(),
  }),
  discoveredCount: adminResponse.number(),
  discoveredKeysDigest: adminResponse.string(),
  deletedCount: adminResponse.number(),
  residualCount: adminResponse.number(),
  residualKeysDigest: adminResponse.string(),
  outcome: adminResponse.union([
    adminResponse.literal('FULLY_INVALIDATED'),
    adminResponse.literal('RESIDUAL_KEYS_PRESENT'),
  ] as const),
});

export type DebugToolsCacheInvalidationReceiptDto = AdminResponseProjection<
  typeof debugToolsCacheInvalidationReceiptContract
>;

export const debugToolsFeatureFlagOverrideContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  featureKey: adminResponse.string(),
  originalValue: adminResponse.json('debug-observation'),
  overrideValue: adminResponse.json('debug-observation'),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  adminId: adminResponse.string(),
  reason: adminResponse.optional(adminResponse.string()),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  appliedAt: adminResponse.optional(adminResponse.dateString()),
  revertedAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
});

export type DebugToolsFeatureFlagOverrideDto = AdminResponseProjection<
  typeof debugToolsFeatureFlagOverrideContract
>;

export const debugToolsGetFeatureFlagValueResponseContract = adminResponse.object({
  value: adminResponse.json('debug-observation'),
});

export type DebugToolsGetFeatureFlagValueResponseDto = AdminResponseProjection<
  typeof debugToolsGetFeatureFlagValueResponseContract
>;

export const debugToolsQueryOverridesResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      featureKey: adminResponse.string(),
      originalValue: adminResponse.json('debug-observation'),
      overrideValue: adminResponse.json('debug-observation'),
      isActive: adminResponse.boolean(),
      adminId: adminResponse.string(),
      reason: adminResponse.optional(adminResponse.string()),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      appliedAt: adminResponse.optional(adminResponse.dateString()),
      revertedAt: adminResponse.optional(adminResponse.dateString()),
      revertedBy: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type DebugToolsQueryOverridesResponseDto = AdminResponseProjection<
  typeof debugToolsQueryOverridesResponseContract
>;

export const impersonationImpersonationPermissionContract = adminResponse.object({
  id: adminResponse.string(),
  superAdminId: adminResponse.string(),
  superAdminEmail: adminResponse.optional(adminResponse.string()),
  canImpersonate: adminResponse.boolean(),
  isActive: adminResponse.boolean(),
  allowedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
  restrictedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
  defaultPermissions: adminResponse.optional(
    adminResponse.object({
      canViewData: adminResponse.boolean(),
      canModifyData: adminResponse.boolean(),
      canAccessSettings: adminResponse.boolean(),
      canManageUsers: adminResponse.boolean(),
      canViewBilling: adminResponse.boolean(),
      canExportData: adminResponse.boolean(),
      restrictedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
      allowedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
    }),
  ),
  maxSessionDurationMinutes: adminResponse.number(),
  maxConcurrentSessions: adminResponse.number(),
  requireReason: adminResponse.boolean(),
  requireTicketReference: adminResponse.boolean(),
  notifyTenantAdmin: adminResponse.boolean(),
  grantedBy: adminResponse.optional(adminResponse.string()),
  grantedAt: adminResponse.optional(adminResponse.dateString()),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  notes: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ImpersonationImpersonationPermissionDto = AdminResponseProjection<
  typeof impersonationImpersonationPermissionContract
>;

export const impersonationGetStatsResponseContract = adminResponse.object({
  activeSessions: adminResponse.number(),
  totalSessions: adminResponse.number(),
  activePermissions: adminResponse.number(),
  topAdmins: adminResponse.array(
    adminResponse.object({
      adminId: adminResponse.string(),
      email: adminResponse.string(),
      sessionCount: adminResponse.number(),
    }),
  ),
  recentSessions: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      superAdminId: adminResponse.string(),
      superAdminEmail: adminResponse.optional(adminResponse.string()),
      targetTenantId: adminResponse.string(),
      targetTenantName: adminResponse.optional(adminResponse.string()),
      targetUserId: adminResponse.optional(adminResponse.string()),
      targetUserEmail: adminResponse.optional(adminResponse.string()),
      status: adminResponse.union([
        adminResponse.literal('active'),
        adminResponse.literal('ended'),
        adminResponse.literal('expired'),
        adminResponse.literal('terminated'),
      ] as const),
      reason: adminResponse.union([
        adminResponse.literal('support_request'),
        adminResponse.literal('debugging'),
        adminResponse.literal('configuration'),
        adminResponse.literal('onboarding_assistance'),
        adminResponse.literal('security_investigation'),
        adminResponse.literal('data_verification'),
        adminResponse.literal('other'),
      ] as const),
      reasonDetails: adminResponse.optional(adminResponse.string()),
      ticketReference: adminResponse.optional(adminResponse.string()),
      ipAddress: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      mfaCompleted: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      expiresAt: adminResponse.dateString(),
      endedAt: adminResponse.optional(adminResponse.dateString()),
      endReason: adminResponse.optional(adminResponse.string()),
      actionCount: adminResponse.number(),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
});

export type ImpersonationGetStatsResponseDto = AdminResponseProjection<
  typeof impersonationGetStatsResponseContract
>;

export const impersonationGetPermissionResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    superAdminId: adminResponse.string(),
    superAdminEmail: adminResponse.optional(adminResponse.string()),
    canImpersonate: adminResponse.boolean(),
    isActive: adminResponse.boolean(),
    allowedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
    restrictedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
    defaultPermissions: adminResponse.optional(
      adminResponse.object({
        canViewData: adminResponse.boolean(),
        canModifyData: adminResponse.boolean(),
        canAccessSettings: adminResponse.boolean(),
        canManageUsers: adminResponse.boolean(),
        canViewBilling: adminResponse.boolean(),
        canExportData: adminResponse.boolean(),
        restrictedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
        allowedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
      }),
    ),
    maxSessionDurationMinutes: adminResponse.number(),
    maxConcurrentSessions: adminResponse.number(),
    requireReason: adminResponse.boolean(),
    requireTicketReference: adminResponse.boolean(),
    notifyTenantAdmin: adminResponse.boolean(),
    grantedBy: adminResponse.optional(adminResponse.string()),
    grantedAt: adminResponse.optional(adminResponse.dateString()),
    expiresAt: adminResponse.optional(adminResponse.dateString()),
    notes: adminResponse.optional(adminResponse.string()),
    createdAt: adminResponse.dateString(),
    updatedAt: adminResponse.dateString(),
  }),
);

export type ImpersonationGetPermissionResponseDto = AdminResponseProjection<
  typeof impersonationGetPermissionResponseContract
>;

export const impersonationCheckPermissionResponseContract = adminResponse.object({
  allowed: adminResponse.boolean(),
  reason: adminResponse.optional(adminResponse.string()),
  permission: adminResponse.optional(
    adminResponse.object({
      id: adminResponse.string(),
      superAdminId: adminResponse.string(),
      superAdminEmail: adminResponse.optional(adminResponse.string()),
      canImpersonate: adminResponse.boolean(),
      isActive: adminResponse.boolean(),
      allowedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      restrictedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      defaultPermissions: adminResponse.optional(
        adminResponse.object({
          canViewData: adminResponse.boolean(),
          canModifyData: adminResponse.boolean(),
          canAccessSettings: adminResponse.boolean(),
          canManageUsers: adminResponse.boolean(),
          canViewBilling: adminResponse.boolean(),
          canExportData: adminResponse.boolean(),
          restrictedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
          allowedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
        }),
      ),
      maxSessionDurationMinutes: adminResponse.number(),
      maxConcurrentSessions: adminResponse.number(),
      requireReason: adminResponse.boolean(),
      requireTicketReference: adminResponse.boolean(),
      notifyTenantAdmin: adminResponse.boolean(),
      grantedBy: adminResponse.optional(adminResponse.string()),
      grantedAt: adminResponse.optional(adminResponse.dateString()),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      notes: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
});

export type ImpersonationCheckPermissionResponseDto = AdminResponseProjection<
  typeof impersonationCheckPermissionResponseContract
>;

export const impersonationStartImpersonationResponseContract = adminResponse.object({
  impersonationToken: adminResponse.string(),
  id: adminResponse.string(),
  superAdminId: adminResponse.string(),
  superAdminEmail: adminResponse.optional(adminResponse.string()),
  targetTenantId: adminResponse.string(),
  targetTenantName: adminResponse.optional(adminResponse.string()),
  targetUserId: adminResponse.optional(adminResponse.string()),
  targetUserEmail: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('active'),
    adminResponse.literal('ended'),
    adminResponse.literal('expired'),
    adminResponse.literal('terminated'),
  ] as const),
  reason: adminResponse.union([
    adminResponse.literal('support_request'),
    adminResponse.literal('debugging'),
    adminResponse.literal('configuration'),
    adminResponse.literal('onboarding_assistance'),
    adminResponse.literal('security_investigation'),
    adminResponse.literal('data_verification'),
    adminResponse.literal('other'),
  ] as const),
  reasonDetails: adminResponse.optional(adminResponse.string()),
  ticketReference: adminResponse.optional(adminResponse.string()),
  ipAddress: adminResponse.optional(adminResponse.string()),
  userAgent: adminResponse.optional(adminResponse.string()),
  mfaCompleted: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  expiresAt: adminResponse.dateString(),
  endedAt: adminResponse.optional(adminResponse.dateString()),
  endReason: adminResponse.optional(adminResponse.string()),
  actionCount: adminResponse.number(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ImpersonationStartImpersonationResponseDto = AdminResponseProjection<
  typeof impersonationStartImpersonationResponseContract
>;

export const impersonationImpersonationSessionContract = adminResponse.object({
  id: adminResponse.string(),
  superAdminId: adminResponse.string(),
  superAdminEmail: adminResponse.optional(adminResponse.string()),
  targetTenantId: adminResponse.string(),
  targetTenantName: adminResponse.optional(adminResponse.string()),
  targetUserId: adminResponse.optional(adminResponse.string()),
  targetUserEmail: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('active'),
    adminResponse.literal('ended'),
    adminResponse.literal('expired'),
    adminResponse.literal('terminated'),
  ] as const),
  reason: adminResponse.union([
    adminResponse.literal('support_request'),
    adminResponse.literal('debugging'),
    adminResponse.literal('configuration'),
    adminResponse.literal('onboarding_assistance'),
    adminResponse.literal('security_investigation'),
    adminResponse.literal('data_verification'),
    adminResponse.literal('other'),
  ] as const),
  reasonDetails: adminResponse.optional(adminResponse.string()),
  ticketReference: adminResponse.optional(adminResponse.string()),
  ipAddress: adminResponse.optional(adminResponse.string()),
  userAgent: adminResponse.optional(adminResponse.string()),
  mfaCompleted: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  expiresAt: adminResponse.dateString(),
  endedAt: adminResponse.optional(adminResponse.dateString()),
  endReason: adminResponse.optional(adminResponse.string()),
  actionCount: adminResponse.number(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ImpersonationImpersonationSessionDto = AdminResponseProjection<
  typeof impersonationImpersonationSessionContract
>;

const impersonationAuthorizationContextContract = adminResponse.object({
  sessionId: adminResponse.string(),
  superAdminId: adminResponse.string(),
  targetTenantId: adminResponse.string(),
  targetUserId: adminResponse.optional(adminResponse.string()),
  permissions: adminResponse.object({
    canViewData: adminResponse.boolean(),
    canModifyData: adminResponse.boolean(),
    canAccessSettings: adminResponse.boolean(),
    canManageUsers: adminResponse.boolean(),
    canViewBilling: adminResponse.boolean(),
    canExportData: adminResponse.boolean(),
    restrictedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
    allowedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
  }),
  expiresAt: adminResponse.dateString(),
  isActive: adminResponse.boolean(),
});

/** Read-only gateway context resolution. This route never records an authorization decision. */
export const impersonationAuthorizationContextResponseContract = adminResponse.object({
  context: impersonationAuthorizationContextContract,
});

export type ImpersonationAuthorizationContextResponseDto = AdminResponseProjection<
  typeof impersonationAuthorizationContextResponseContract
>;

/** Exact-operation authorization decision receipt committed before an outward request. */
export const impersonationAuthorizationReceiptResponseContract = adminResponse.object({
  authorizationReceiptId: adminResponse.string(),
  requestDigest: adminResponse.string(),
  replayed: adminResponse.boolean(),
  context: impersonationAuthorizationContextContract,
});

export type ImpersonationAuthorizationReceiptResponseDto = AdminResponseProjection<
  typeof impersonationAuthorizationReceiptResponseContract
>;

export const impersonationGetActiveSessionCountResponseContract = adminResponse.object({
  count: adminResponse.number(),
});

export type ImpersonationGetActiveSessionCountResponseDto = AdminResponseProjection<
  typeof impersonationGetActiveSessionCountResponseContract
>;

export const impersonationQuerySessionsPageContract = adminResponse.page(
  impersonationImpersonationSessionContract,
);

export const impersonationImpersonationAuditSummaryContract = adminResponse.object({
  totalSessions: adminResponse.number(),
  activeSessions: adminResponse.number(),
  sessionsByReason: adminResponse.object({
    support_request: adminResponse.number(),
    debugging: adminResponse.number(),
    configuration: adminResponse.number(),
    onboarding_assistance: adminResponse.number(),
    security_investigation: adminResponse.number(),
    data_verification: adminResponse.number(),
    other: adminResponse.number(),
  }),
  topImpersonators: adminResponse.array(
    adminResponse.object({
      adminId: adminResponse.string(),
      email: adminResponse.string(),
      sessionCount: adminResponse.number(),
    }),
  ),
  topTargetTenants: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      sessionCount: adminResponse.number(),
    }),
  ),
  recentSessions: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      superAdminId: adminResponse.string(),
      superAdminEmail: adminResponse.optional(adminResponse.string()),
      targetTenantId: adminResponse.string(),
      targetTenantName: adminResponse.optional(adminResponse.string()),
      targetUserId: adminResponse.optional(adminResponse.string()),
      targetUserEmail: adminResponse.optional(adminResponse.string()),
      status: adminResponse.union([
        adminResponse.literal('active'),
        adminResponse.literal('ended'),
        adminResponse.literal('expired'),
        adminResponse.literal('terminated'),
      ] as const),
      reason: adminResponse.union([
        adminResponse.literal('support_request'),
        adminResponse.literal('debugging'),
        adminResponse.literal('configuration'),
        adminResponse.literal('onboarding_assistance'),
        adminResponse.literal('security_investigation'),
        adminResponse.literal('data_verification'),
        adminResponse.literal('other'),
      ] as const),
      reasonDetails: adminResponse.optional(adminResponse.string()),
      ticketReference: adminResponse.optional(adminResponse.string()),
      permissions: adminResponse.optional(
        adminResponse.object({
          canViewData: adminResponse.boolean(),
          canModifyData: adminResponse.boolean(),
          canAccessSettings: adminResponse.boolean(),
          canManageUsers: adminResponse.boolean(),
          canViewBilling: adminResponse.boolean(),
          canExportData: adminResponse.boolean(),
          restrictedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
          allowedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
        }),
      ),
      ipAddress: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      mfaCompleted: adminResponse.boolean(),
      expiresAt: adminResponse.dateString(),
      endedAt: adminResponse.optional(adminResponse.dateString()),
      endReason: adminResponse.optional(adminResponse.string()),
      actionsPerformed: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            action: adminResponse.string(),
            resource: adminResponse.string(),
            resourceId: adminResponse.optional(adminResponse.string()),
            timestamp: adminResponse.string(),
            details: adminResponse.optional(
              adminResponse.record(adminResponse.json('security-audit-context')),
            ),
          }),
        ),
      ),
      actionCount: adminResponse.number(),
      accessedResources: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            type: adminResponse.string(),
            id: adminResponse.string(),
            action: adminResponse.string(),
            timestamp: adminResponse.string(),
          }),
        ),
      ),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
});

export type ImpersonationImpersonationAuditSummaryDto = AdminResponseProjection<
  typeof impersonationImpersonationAuditSummaryContract
>;

export const debugToolsDebugSessionArrayContract = adminResponse.array(
  debugToolsDebugSessionContract,
);

export const debugToolsDebugSessionPageContract = adminResponse.page(
  debugToolsDebugSessionContract,
);

export const debugToolsFeatureFlagOverrideArrayContract = adminResponse.array(
  debugToolsFeatureFlagOverrideContract,
);

export const impersonationImpersonationPermissionPageContract = adminResponse.page(
  impersonationImpersonationPermissionContract,
);

export const impersonationImpersonationSessionArrayContract = adminResponse.array(
  impersonationImpersonationSessionContract,
);
