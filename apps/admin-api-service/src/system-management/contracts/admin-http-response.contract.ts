import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const errorTrackingErrorDashboardContract = adminResponse.object({
  totalErrors: adminResponse.number(),
  newErrors: adminResponse.number(),
  unresolvedGroups: adminResponse.number(),
  errorsByService: adminResponse.array(
    adminResponse.object({
      service: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  errorsBySeverity: adminResponse.array(
    adminResponse.object({
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      count: adminResponse.number(),
    }),
  ),
  recentErrors: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      groupId: adminResponse.string(),
      fingerprint: adminResponse.string(),
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      message: adminResponse.string(),
      errorType: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      stackFrames: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            filename: adminResponse.string(),
            function: adminResponse.string(),
            lineno: adminResponse.number(),
            colno: adminResponse.optional(adminResponse.number()),
            context: adminResponse.optional(adminResponse.array(adminResponse.string())),
            inApp: adminResponse.optional(
              adminResponse.union([
                adminResponse.literal(false),
                adminResponse.literal(true),
              ] as const),
            ),
          }),
        ),
      ),
      context: adminResponse.optional(
        adminResponse.object({
          user: adminResponse.optional(
            adminResponse.object({
              id: adminResponse.string(),
              email: adminResponse.optional(adminResponse.string()),
              tenantId: adminResponse.optional(adminResponse.string()),
            }),
          ),
          request: adminResponse.optional(
            adminResponse.object({
              method: adminResponse.string(),
              url: adminResponse.string(),
              headers: adminResponse.optional(adminResponse.record(adminResponse.string())),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
              queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
            }),
          ),
          response: adminResponse.optional(
            adminResponse.object({
              statusCode: adminResponse.number(),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
            }),
          ),
          tags: adminResponse.optional(adminResponse.record(adminResponse.string())),
          extra: adminResponse.optional(
            adminResponse.record(adminResponse.json('security-audit-context')),
          ),
          breadcrumbs: adminResponse.optional(
            adminResponse.array(
              adminResponse.object({
                type: adminResponse.string(),
                category: adminResponse.string(),
                message: adminResponse.string(),
                timestamp: adminResponse.dateString(),
                data: adminResponse.optional(
                  adminResponse.record(adminResponse.json('security-audit-context')),
                ),
              }),
            ),
          ),
        }),
      ),
      service: adminResponse.optional(adminResponse.string()),
      environment: adminResponse.optional(adminResponse.string()),
      release: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      ipAddress: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  topErrorGroups: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      fingerprint: adminResponse.string(),
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('new'),
        adminResponse.literal('acknowledged'),
        adminResponse.literal('in_progress'),
        adminResponse.literal('resolved'),
        adminResponse.literal('ignored'),
        adminResponse.literal('recurring'),
      ] as const),
      message: adminResponse.string(),
      errorType: adminResponse.optional(adminResponse.string()),
      service: adminResponse.optional(adminResponse.string()),
      culprit: adminResponse.optional(adminResponse.string()),
      occurrenceCount: adminResponse.number(),
      userCount: adminResponse.number(),
      firstSeenAt: adminResponse.dateString(),
      lastSeenAt: adminResponse.dateString(),
      affectedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      affectedReleases: adminResponse.optional(adminResponse.array(adminResponse.string())),
      tags: adminResponse.optional(
        adminResponse.record(adminResponse.array(adminResponse.string())),
      ),
      assignedTo: adminResponse.optional(adminResponse.string()),
      notes: adminResponse.optional(adminResponse.string()),
      resolvedAt: adminResponse.optional(adminResponse.dateString()),
      resolvedBy: adminResponse.optional(adminResponse.string()),
      resolutionNotes: adminResponse.optional(adminResponse.string()),
      linkedTicketUrl: adminResponse.optional(adminResponse.string()),
      isRegression: adminResponse.boolean(),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  errorTrend: adminResponse.array(
    adminResponse.object({
      date: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
});

export type ErrorTrackingErrorDashboardDto = AdminResponseProjection<
  typeof errorTrackingErrorDashboardContract
>;

export const errorTrackingGetErrorStatsResponseContract = adminResponse.object({
  key: adminResponse.string(),
  count: adminResponse.number(),
  percentage: adminResponse.number(),
});

export type ErrorTrackingGetErrorStatsResponseDto = AdminResponseProjection<
  typeof errorTrackingGetErrorStatsResponseContract
>;

export const errorTrackingErrorOccurrenceContract = adminResponse.object({
  id: adminResponse.string(),
  groupId: adminResponse.string(),
  message: adminResponse.string(),
  stackTrace: adminResponse.optional(adminResponse.string()),
  context: adminResponse.optional(
    adminResponse.object({
      user: adminResponse.optional(
        adminResponse.object({
          id: adminResponse.string(),
          email: adminResponse.optional(adminResponse.string()),
          tenantId: adminResponse.optional(adminResponse.string()),
        }),
      ),
      request: adminResponse.optional(
        adminResponse.object({
          method: adminResponse.string(),
          url: adminResponse.string(),
          headers: adminResponse.optional(adminResponse.record(adminResponse.string())),
          body: adminResponse.optional(adminResponse.json('security-audit-context')),
          queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
        }),
      ),
      response: adminResponse.optional(
        adminResponse.object({
          statusCode: adminResponse.number(),
          body: adminResponse.optional(adminResponse.json('security-audit-context')),
        }),
      ),
      tags: adminResponse.optional(adminResponse.record(adminResponse.string())),
      extra: adminResponse.optional(
        adminResponse.record(adminResponse.json('security-audit-context')),
      ),
      breadcrumbs: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            type: adminResponse.string(),
            category: adminResponse.string(),
            message: adminResponse.string(),
            timestamp: adminResponse.dateString(),
            data: adminResponse.optional(
              adminResponse.record(adminResponse.json('security-audit-context')),
            ),
          }),
        ),
      ),
    }),
  ),
  tenantId: adminResponse.optional(adminResponse.string()),
  userId: adminResponse.optional(adminResponse.string()),
  timestamp: adminResponse.dateString(),
});

export type ErrorTrackingErrorOccurrenceDto = AdminResponseProjection<
  typeof errorTrackingErrorOccurrenceContract
>;

export const errorTrackingQueryErrorGroupsResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      fingerprint: adminResponse.string(),
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('new'),
        adminResponse.literal('acknowledged'),
        adminResponse.literal('in_progress'),
        adminResponse.literal('resolved'),
        adminResponse.literal('ignored'),
        adminResponse.literal('recurring'),
      ] as const),
      message: adminResponse.string(),
      errorType: adminResponse.optional(adminResponse.string()),
      service: adminResponse.optional(adminResponse.string()),
      culprit: adminResponse.optional(adminResponse.string()),
      occurrenceCount: adminResponse.number(),
      userCount: adminResponse.number(),
      firstSeenAt: adminResponse.dateString(),
      lastSeenAt: adminResponse.dateString(),
      affectedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      affectedReleases: adminResponse.optional(adminResponse.array(adminResponse.string())),
      tags: adminResponse.optional(
        adminResponse.record(adminResponse.array(adminResponse.string())),
      ),
      assignedTo: adminResponse.optional(adminResponse.string()),
      notes: adminResponse.optional(adminResponse.string()),
      resolvedAt: adminResponse.optional(adminResponse.dateString()),
      resolvedBy: adminResponse.optional(adminResponse.string()),
      resolutionNotes: adminResponse.optional(adminResponse.string()),
      linkedTicketUrl: adminResponse.optional(adminResponse.string()),
      isRegression: adminResponse.boolean(),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type ErrorTrackingQueryErrorGroupsResponseDto = AdminResponseProjection<
  typeof errorTrackingQueryErrorGroupsResponseContract
>;

export const errorTrackingErrorGroupContract = adminResponse.object({
  id: adminResponse.string(),
  fingerprint: adminResponse.string(),
  message: adminResponse.string(),
  errorType: adminResponse.optional(adminResponse.string()),
  service: adminResponse.optional(adminResponse.string()),
  severity: adminResponse.union([
    adminResponse.literal('debug'),
    adminResponse.literal('info'),
    adminResponse.literal('warning'),
    adminResponse.literal('error'),
    adminResponse.literal('critical'),
    adminResponse.literal('fatal'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('new'),
    adminResponse.literal('acknowledged'),
    adminResponse.literal('in_progress'),
    adminResponse.literal('resolved'),
    adminResponse.literal('ignored'),
    adminResponse.literal('recurring'),
  ] as const),
  occurrenceCount: adminResponse.number(),
  userCount: adminResponse.number(),
  firstSeenAt: adminResponse.dateString(),
  lastSeenAt: adminResponse.dateString(),
  assignedTo: adminResponse.optional(adminResponse.string()),
  isRegression: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type ErrorTrackingErrorGroupDto = AdminResponseProjection<
  typeof errorTrackingErrorGroupContract
>;

export const errorTrackingQueryOccurrencesResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      groupId: adminResponse.string(),
      fingerprint: adminResponse.string(),
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      message: adminResponse.string(),
      errorType: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      stackFrames: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            filename: adminResponse.string(),
            function: adminResponse.string(),
            lineno: adminResponse.number(),
            colno: adminResponse.optional(adminResponse.number()),
            context: adminResponse.optional(adminResponse.array(adminResponse.string())),
            inApp: adminResponse.optional(
              adminResponse.union([
                adminResponse.literal(false),
                adminResponse.literal(true),
              ] as const),
            ),
          }),
        ),
      ),
      context: adminResponse.optional(
        adminResponse.object({
          user: adminResponse.optional(
            adminResponse.object({
              id: adminResponse.string(),
              email: adminResponse.optional(adminResponse.string()),
              tenantId: adminResponse.optional(adminResponse.string()),
            }),
          ),
          request: adminResponse.optional(
            adminResponse.object({
              method: adminResponse.string(),
              url: adminResponse.string(),
              headers: adminResponse.optional(adminResponse.record(adminResponse.string())),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
              queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
            }),
          ),
          response: adminResponse.optional(
            adminResponse.object({
              statusCode: adminResponse.number(),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
            }),
          ),
          tags: adminResponse.optional(adminResponse.record(adminResponse.string())),
          extra: adminResponse.optional(
            adminResponse.record(adminResponse.json('security-audit-context')),
          ),
          breadcrumbs: adminResponse.optional(
            adminResponse.array(
              adminResponse.object({
                type: adminResponse.string(),
                category: adminResponse.string(),
                message: adminResponse.string(),
                timestamp: adminResponse.dateString(),
                data: adminResponse.optional(
                  adminResponse.record(adminResponse.json('security-audit-context')),
                ),
              }),
            ),
          ),
        }),
      ),
      service: adminResponse.optional(adminResponse.string()),
      environment: adminResponse.optional(adminResponse.string()),
      release: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      ipAddress: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type ErrorTrackingQueryOccurrencesResponseDto = AdminResponseProjection<
  typeof errorTrackingQueryOccurrencesResponseContract
>;

export const errorTrackingGetOccurrencesForGroupResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      groupId: adminResponse.string(),
      fingerprint: adminResponse.string(),
      severity: adminResponse.union([
        adminResponse.literal('debug'),
        adminResponse.literal('info'),
        adminResponse.literal('warning'),
        adminResponse.literal('error'),
        adminResponse.literal('critical'),
        adminResponse.literal('fatal'),
      ] as const),
      message: adminResponse.string(),
      errorType: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      stackFrames: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            filename: adminResponse.string(),
            function: adminResponse.string(),
            lineno: adminResponse.number(),
            colno: adminResponse.optional(adminResponse.number()),
            context: adminResponse.optional(adminResponse.array(adminResponse.string())),
            inApp: adminResponse.optional(
              adminResponse.union([
                adminResponse.literal(false),
                adminResponse.literal(true),
              ] as const),
            ),
          }),
        ),
      ),
      context: adminResponse.optional(
        adminResponse.object({
          user: adminResponse.optional(
            adminResponse.object({
              id: adminResponse.string(),
              email: adminResponse.optional(adminResponse.string()),
              tenantId: adminResponse.optional(adminResponse.string()),
            }),
          ),
          request: adminResponse.optional(
            adminResponse.object({
              method: adminResponse.string(),
              url: adminResponse.string(),
              headers: adminResponse.optional(adminResponse.record(adminResponse.string())),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
              queryParams: adminResponse.optional(adminResponse.record(adminResponse.string())),
            }),
          ),
          response: adminResponse.optional(
            adminResponse.object({
              statusCode: adminResponse.number(),
              body: adminResponse.optional(adminResponse.json('security-audit-context')),
            }),
          ),
          tags: adminResponse.optional(adminResponse.record(adminResponse.string())),
          extra: adminResponse.optional(
            adminResponse.record(adminResponse.json('security-audit-context')),
          ),
          breadcrumbs: adminResponse.optional(
            adminResponse.array(
              adminResponse.object({
                type: adminResponse.string(),
                category: adminResponse.string(),
                message: adminResponse.string(),
                timestamp: adminResponse.dateString(),
                data: adminResponse.optional(
                  adminResponse.record(adminResponse.json('security-audit-context')),
                ),
              }),
            ),
          ),
        }),
      ),
      service: adminResponse.optional(adminResponse.string()),
      environment: adminResponse.optional(adminResponse.string()),
      release: adminResponse.optional(adminResponse.string()),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      ipAddress: adminResponse.optional(adminResponse.string()),
      userAgent: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type ErrorTrackingGetOccurrencesForGroupResponseDto = AdminResponseProjection<
  typeof errorTrackingGetOccurrencesForGroupResponseContract
>;

export const errorTrackingErrorAlertRuleContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  isActive: adminResponse.boolean(),
  conditions: adminResponse.object({
    severity: adminResponse.optional(
      adminResponse.array(
        adminResponse.union([
          adminResponse.literal('debug'),
          adminResponse.literal('info'),
          adminResponse.literal('warning'),
          adminResponse.literal('error'),
          adminResponse.literal('critical'),
          adminResponse.literal('fatal'),
        ] as const),
      ),
    ),
    service: adminResponse.optional(adminResponse.array(adminResponse.string())),
    errorType: adminResponse.optional(adminResponse.array(adminResponse.string())),
    messagePattern: adminResponse.optional(adminResponse.string()),
    occurrenceThreshold: adminResponse.optional(adminResponse.number()),
    timeWindowMinutes: adminResponse.optional(adminResponse.number()),
    userCountThreshold: adminResponse.optional(adminResponse.number()),
  }),
  actions: adminResponse.array(
    adminResponse.object({
      type: adminResponse.union([
        adminResponse.literal('email'),
        adminResponse.literal('webhook'),
        adminResponse.literal('slack'),
        adminResponse.literal('sms'),
        adminResponse.literal('pagerduty'),
      ] as const),
      config: adminResponse.record(adminResponse.json('security-audit-context')),
    }),
  ),
  cooldownMinutes: adminResponse.number(),
  lastTriggeredAt: adminResponse.optional(adminResponse.dateString()),
  triggerCount: adminResponse.number(),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ErrorTrackingErrorAlertRuleDto = AdminResponseProjection<
  typeof errorTrackingErrorAlertRuleContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const globalSettingsFeatureToggleContract = adminResponse.object({
  id: adminResponse.string(),
  key: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('enabled'),
    adminResponse.literal('disabled'),
    adminResponse.literal('percentage_rollout'),
    adminResponse.literal('scheduled'),
  ] as const),
  scope: adminResponse.union([
    adminResponse.literal('global'),
    adminResponse.literal('tenant'),
    adminResponse.literal('user'),
    adminResponse.literal('environment'),
  ] as const),
  category: adminResponse.optional(adminResponse.string()),
  rolloutPercentage: adminResponse.number(),
  enabledTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
  disabledTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
  conditions: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        type: adminResponse.union([
          adminResponse.literal('tenant_id'),
          adminResponse.literal('user_role'),
          adminResponse.literal('plan_type'),
          adminResponse.literal('region'),
          adminResponse.literal('custom'),
        ] as const),
        operator: adminResponse.union([
          adminResponse.literal('equals'),
          adminResponse.literal('not_equals'),
          adminResponse.literal('contains'),
          adminResponse.literal('in'),
          adminResponse.literal('not_in'),
          adminResponse.literal('regex'),
        ] as const),
        value: adminResponse.union([
          adminResponse.string(),
          adminResponse.array(adminResponse.string()),
        ] as const),
      }),
    ),
  ),
  variants: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        key: adminResponse.string(),
        value: adminResponse.json('operator-configuration'),
        weight: adminResponse.number(),
      }),
    ),
  ),
  isExperimental: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  deprecatedAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type GlobalSettingsFeatureToggleDto = AdminResponseProjection<
  typeof globalSettingsFeatureToggleContract
>;

export const globalSettingsQueryFeatureTogglesResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      key: adminResponse.string(),
      name: adminResponse.string(),
      description: adminResponse.optional(adminResponse.string()),
      scope: adminResponse.union([
        adminResponse.literal('global'),
        adminResponse.literal('tenant'),
        adminResponse.literal('user'),
        adminResponse.literal('environment'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('enabled'),
        adminResponse.literal('disabled'),
        adminResponse.literal('percentage_rollout'),
        adminResponse.literal('scheduled'),
      ] as const),
      category: adminResponse.optional(adminResponse.string()),
      conditions: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            type: adminResponse.union([
              adminResponse.literal('tenant_id'),
              adminResponse.literal('user_role'),
              adminResponse.literal('plan_type'),
              adminResponse.literal('region'),
              adminResponse.literal('custom'),
            ] as const),
            operator: adminResponse.union([
              adminResponse.literal('equals'),
              adminResponse.literal('not_equals'),
              adminResponse.literal('contains'),
              adminResponse.literal('in'),
              adminResponse.literal('not_in'),
              adminResponse.literal('regex'),
            ] as const),
            value: adminResponse.union([
              adminResponse.string(),
              adminResponse.array(adminResponse.string()),
            ] as const),
          }),
        ),
      ),
      rolloutPercentage: adminResponse.number(),
      rolloutSchedule: adminResponse.optional(
        adminResponse.object({
          startDate: adminResponse.dateString(),
          endDate: adminResponse.optional(adminResponse.dateString()),
          percentage: adminResponse.number(),
          targetPercentage: adminResponse.optional(adminResponse.number()),
          incrementPerDay: adminResponse.optional(adminResponse.number()),
        }),
      ),
      enabledTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      disabledTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      defaultValue: adminResponse.optional(adminResponse.json('operator-configuration')),
      variants: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            key: adminResponse.string(),
            value: adminResponse.json('operator-configuration'),
            weight: adminResponse.number(),
            description: adminResponse.optional(adminResponse.string()),
          }),
        ),
      ),
      requiresRestart: adminResponse.boolean(),
      isExperimental: adminResponse.boolean(),
      deprecatedAt: adminResponse.optional(adminResponse.dateString()),
      deprecationMessage: adminResponse.optional(adminResponse.string()),
      createdBy: adminResponse.optional(adminResponse.string()),
      updatedBy: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type GlobalSettingsQueryFeatureTogglesResponseDto = AdminResponseProjection<
  typeof globalSettingsQueryFeatureTogglesResponseContract
>;

export const globalSettingsEvaluateFeatureToggleResponseContract = adminResponse.object({
  key: adminResponse.string(),
  enabled: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  variant: adminResponse.optional(adminResponse.string()),
  value: adminResponse.optional(adminResponse.json('operator-configuration')),
  reason: adminResponse.string(),
});

export type GlobalSettingsEvaluateFeatureToggleResponseDto = AdminResponseProjection<
  typeof globalSettingsEvaluateFeatureToggleResponseContract
>;

export const globalSettingsMaintenanceWindowContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  description: adminResponse.string(),
  scope: adminResponse.union([
    adminResponse.literal('global'),
    adminResponse.literal('tenant'),
    adminResponse.literal('service'),
    adminResponse.literal('region'),
  ] as const),
  type: adminResponse.union([
    adminResponse.literal('scheduled'),
    adminResponse.literal('emergency'),
    adminResponse.literal('rolling_update'),
    adminResponse.literal('database_migration'),
    adminResponse.literal('security_patch'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('scheduled'),
    adminResponse.literal('in_progress'),
    adminResponse.literal('completed'),
    adminResponse.literal('cancelled'),
    adminResponse.literal('extended'),
  ] as const),
  tenantId: adminResponse.optional(adminResponse.string()),
  affectedServices: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        name: adminResponse.string(),
        status: adminResponse.union([
          adminResponse.literal('degraded'),
          adminResponse.literal('unavailable'),
          adminResponse.literal('read_only'),
        ] as const),
      }),
    ),
  ),
  scheduledStart: adminResponse.dateString(),
  scheduledEnd: adminResponse.optional(adminResponse.dateString()),
  actualStart: adminResponse.optional(adminResponse.dateString()),
  actualEnd: adminResponse.optional(adminResponse.dateString()),
  userMessage: adminResponse.optional(adminResponse.string()),
  allowReadOnlyAccess: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  bypassForSuperAdmins: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
});

export type GlobalSettingsMaintenanceWindowDto = AdminResponseProjection<
  typeof globalSettingsMaintenanceWindowContract
>;

export const globalSettingsQueryMaintenanceModesResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      title: adminResponse.string(),
      description: adminResponse.string(),
      scope: adminResponse.union([
        adminResponse.literal('global'),
        adminResponse.literal('tenant'),
        adminResponse.literal('service'),
        adminResponse.literal('region'),
      ] as const),
      type: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('emergency'),
        adminResponse.literal('rolling_update'),
        adminResponse.literal('database_migration'),
        adminResponse.literal('security_patch'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('in_progress'),
        adminResponse.literal('completed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('extended'),
      ] as const),
      tenantId: adminResponse.optional(adminResponse.string()),
      affectedTenants: adminResponse.optional(adminResponse.array(adminResponse.string())),
      affectedServices: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            name: adminResponse.string(),
            status: adminResponse.union([
              adminResponse.literal('degraded'),
              adminResponse.literal('unavailable'),
              adminResponse.literal('read_only'),
            ] as const),
            message: adminResponse.optional(adminResponse.string()),
          }),
        ),
      ),
      affectedRegions: adminResponse.optional(adminResponse.array(adminResponse.string())),
      scheduledStart: adminResponse.dateString(),
      scheduledEnd: adminResponse.optional(adminResponse.dateString()),
      actualStart: adminResponse.optional(adminResponse.dateString()),
      actualEnd: adminResponse.optional(adminResponse.dateString()),
      estimatedDurationMinutes: adminResponse.number(),
      userMessage: adminResponse.optional(adminResponse.string()),
      internalNotes: adminResponse.optional(adminResponse.string()),
      notifications: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            type: adminResponse.union([
              adminResponse.literal('push'),
              adminResponse.literal('email'),
              adminResponse.literal('webhook'),
              adminResponse.literal('sms'),
              adminResponse.literal('banner'),
            ] as const),
            sentAt: adminResponse.optional(adminResponse.dateString()),
            recipients: adminResponse.optional(adminResponse.array(adminResponse.string())),
            template: adminResponse.optional(adminResponse.string()),
          }),
        ),
      ),
      allowReadOnlyAccess: adminResponse.boolean(),
      bypassForSuperAdmins: adminResponse.boolean(),
      whitelistedIPs: adminResponse.optional(adminResponse.array(adminResponse.string())),
      whitelistedUsers: adminResponse.optional(adminResponse.array(adminResponse.string())),
      bannerColor: adminResponse.optional(adminResponse.string()),
      bannerIcon: adminResponse.optional(adminResponse.string()),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdBy: adminResponse.optional(adminResponse.string()),
      updatedBy: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type GlobalSettingsQueryMaintenanceModesResponseDto = AdminResponseProjection<
  typeof globalSettingsQueryMaintenanceModesResponseContract
>;

export const globalSettingsMaintenanceCheckContract = adminResponse.object({
  isInMaintenance: adminResponse.boolean(),
  maintenanceInfo: adminResponse.optional(
    adminResponse.object({
      id: adminResponse.string(),
      title: adminResponse.string(),
      message: adminResponse.string(),
      estimatedEnd: adminResponse.optional(adminResponse.dateString()),
      allowReadOnly: adminResponse.boolean(),
    }),
  ),
});

export type GlobalSettingsMaintenanceCheckDto = AdminResponseProjection<
  typeof globalSettingsMaintenanceCheckContract
>;

export const globalSettingsSystemVersionContract = adminResponse.object({
  id: adminResponse.string(),
  version: adminResponse.string(),
  majorVersion: adminResponse.number(),
  minorVersion: adminResponse.number(),
  patchVersion: adminResponse.number(),
  preReleaseTag: adminResponse.optional(adminResponse.string()),
  releaseType: adminResponse.union([
    adminResponse.literal('major'),
    adminResponse.literal('minor'),
    adminResponse.literal('patch'),
    adminResponse.literal('hotfix'),
    adminResponse.literal('security'),
    adminResponse.literal('beta'),
    adminResponse.literal('alpha'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('draft'),
    adminResponse.literal('staged'),
    adminResponse.literal('deploying'),
    adminResponse.literal('deployed'),
    adminResponse.literal('rolled_back'),
    adminResponse.literal('deprecated'),
  ] as const),
  title: adminResponse.string(),
  summary: adminResponse.optional(adminResponse.string()),
  changelog: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        type: adminResponse.union([
          adminResponse.literal('security'),
          adminResponse.literal('feature'),
          adminResponse.literal('improvement'),
          adminResponse.literal('bugfix'),
          adminResponse.literal('breaking'),
          adminResponse.literal('deprecated'),
        ] as const),
        title: adminResponse.string(),
        description: adminResponse.string(),
        ticketId: adminResponse.optional(adminResponse.string()),
        pullRequestId: adminResponse.optional(adminResponse.string()),
        affectedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
      }),
    ),
  ),
  migrations: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        name: adminResponse.string(),
        status: adminResponse.union([
          adminResponse.literal('pending'),
          adminResponse.literal('running'),
          adminResponse.literal('completed'),
          adminResponse.literal('failed'),
        ] as const),
        executedAt: adminResponse.optional(adminResponse.dateString()),
        duration: adminResponse.optional(adminResponse.number()),
        error: adminResponse.optional(adminResponse.string()),
      }),
    ),
  ),
  breakingChanges: adminResponse.optional(adminResponse.array(adminResponse.string())),
  deprecations: adminResponse.optional(adminResponse.array(adminResponse.string())),
  newFeatures: adminResponse.optional(adminResponse.array(adminResponse.string())),
  dependencies: adminResponse.optional(adminResponse.record(adminResponse.string())),
  releaseNotes: adminResponse.optional(adminResponse.string()),
  upgradeGuide: adminResponse.optional(adminResponse.string()),
  deployedAt: adminResponse.optional(adminResponse.dateString()),
  deployedBy: adminResponse.optional(adminResponse.string()),
  deploymentDurationSeconds: adminResponse.optional(adminResponse.number()),
  deploymentEnvironments: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        name: adminResponse.string(),
        deployedAt: adminResponse.dateString(),
        status: adminResponse.string(),
      }),
    ),
  ),
  isCurrentVersion: adminResponse.boolean(),
  previousVersion: adminResponse.optional(adminResponse.string()),
  rollbackInfo: adminResponse.optional(
    adminResponse.object({
      rolledBackAt: adminResponse.optional(adminResponse.dateString()),
      rolledBackBy: adminResponse.optional(adminResponse.string()),
      reason: adminResponse.optional(adminResponse.string()),
      targetVersion: adminResponse.optional(adminResponse.string()),
    }),
  ),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
});

export type GlobalSettingsSystemVersionDto = AdminResponseProjection<
  typeof globalSettingsSystemVersionContract
>;

export const globalSettingsQueryVersionsResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      version: adminResponse.string(),
      majorVersion: adminResponse.number(),
      minorVersion: adminResponse.number(),
      patchVersion: adminResponse.number(),
      preReleaseTag: adminResponse.optional(adminResponse.string()),
      releaseType: adminResponse.union([
        adminResponse.literal('major'),
        adminResponse.literal('minor'),
        adminResponse.literal('patch'),
        adminResponse.literal('hotfix'),
        adminResponse.literal('security'),
        adminResponse.literal('beta'),
        adminResponse.literal('alpha'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('draft'),
        adminResponse.literal('staged'),
        adminResponse.literal('deploying'),
        adminResponse.literal('deployed'),
        adminResponse.literal('rolled_back'),
        adminResponse.literal('deprecated'),
      ] as const),
      title: adminResponse.string(),
      summary: adminResponse.optional(adminResponse.string()),
      changelog: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            type: adminResponse.union([
              adminResponse.literal('security'),
              adminResponse.literal('feature'),
              adminResponse.literal('improvement'),
              adminResponse.literal('bugfix'),
              adminResponse.literal('breaking'),
              adminResponse.literal('deprecated'),
            ] as const),
            title: adminResponse.string(),
            description: adminResponse.string(),
            ticketId: adminResponse.optional(adminResponse.string()),
            pullRequestId: adminResponse.optional(adminResponse.string()),
            affectedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
          }),
        ),
      ),
      migrations: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            name: adminResponse.string(),
            status: adminResponse.union([
              adminResponse.literal('pending'),
              adminResponse.literal('running'),
              adminResponse.literal('completed'),
              adminResponse.literal('failed'),
            ] as const),
            executedAt: adminResponse.optional(adminResponse.dateString()),
            duration: adminResponse.optional(adminResponse.number()),
            error: adminResponse.optional(adminResponse.string()),
          }),
        ),
      ),
      breakingChanges: adminResponse.optional(adminResponse.array(adminResponse.string())),
      deprecations: adminResponse.optional(adminResponse.array(adminResponse.string())),
      newFeatures: adminResponse.optional(adminResponse.array(adminResponse.string())),
      dependencies: adminResponse.optional(adminResponse.record(adminResponse.string())),
      releaseNotes: adminResponse.optional(adminResponse.string()),
      upgradeGuide: adminResponse.optional(adminResponse.string()),
      deployedAt: adminResponse.optional(adminResponse.dateString()),
      deployedBy: adminResponse.optional(adminResponse.string()),
      deploymentDurationSeconds: adminResponse.optional(adminResponse.number()),
      deploymentEnvironments: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            name: adminResponse.string(),
            deployedAt: adminResponse.dateString(),
            status: adminResponse.string(),
          }),
        ),
      ),
      isCurrentVersion: adminResponse.boolean(),
      previousVersion: adminResponse.optional(adminResponse.string()),
      rollbackInfo: adminResponse.optional(
        adminResponse.object({
          rolledBackAt: adminResponse.optional(adminResponse.dateString()),
          rolledBackBy: adminResponse.optional(adminResponse.string()),
          reason: adminResponse.optional(adminResponse.string()),
          targetVersion: adminResponse.optional(adminResponse.string()),
        }),
      ),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      createdBy: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type GlobalSettingsQueryVersionsResponseDto = AdminResponseProjection<
  typeof globalSettingsQueryVersionsResponseContract
>;

export const globalSettingsGetCurrentVersionResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    version: adminResponse.string(),
    majorVersion: adminResponse.number(),
    minorVersion: adminResponse.number(),
    patchVersion: adminResponse.number(),
    preReleaseTag: adminResponse.optional(adminResponse.string()),
    releaseType: adminResponse.union([
      adminResponse.literal('major'),
      adminResponse.literal('minor'),
      adminResponse.literal('patch'),
      adminResponse.literal('hotfix'),
      adminResponse.literal('security'),
      adminResponse.literal('beta'),
      adminResponse.literal('alpha'),
    ] as const),
    status: adminResponse.union([
      adminResponse.literal('draft'),
      adminResponse.literal('staged'),
      adminResponse.literal('deploying'),
      adminResponse.literal('deployed'),
      adminResponse.literal('rolled_back'),
      adminResponse.literal('deprecated'),
    ] as const),
    title: adminResponse.string(),
    summary: adminResponse.optional(adminResponse.string()),
    changelog: adminResponse.optional(
      adminResponse.array(
        adminResponse.object({
          type: adminResponse.union([
            adminResponse.literal('security'),
            adminResponse.literal('feature'),
            adminResponse.literal('improvement'),
            adminResponse.literal('bugfix'),
            adminResponse.literal('breaking'),
            adminResponse.literal('deprecated'),
          ] as const),
          title: adminResponse.string(),
          description: adminResponse.string(),
          ticketId: adminResponse.optional(adminResponse.string()),
          pullRequestId: adminResponse.optional(adminResponse.string()),
          affectedModules: adminResponse.optional(adminResponse.array(adminResponse.string())),
        }),
      ),
    ),
    migrations: adminResponse.optional(
      adminResponse.array(
        adminResponse.object({
          name: adminResponse.string(),
          status: adminResponse.union([
            adminResponse.literal('pending'),
            adminResponse.literal('running'),
            adminResponse.literal('completed'),
            adminResponse.literal('failed'),
          ] as const),
          executedAt: adminResponse.optional(adminResponse.dateString()),
          duration: adminResponse.optional(adminResponse.number()),
          error: adminResponse.optional(adminResponse.string()),
        }),
      ),
    ),
    breakingChanges: adminResponse.optional(adminResponse.array(adminResponse.string())),
    deprecations: adminResponse.optional(adminResponse.array(adminResponse.string())),
    newFeatures: adminResponse.optional(adminResponse.array(adminResponse.string())),
    dependencies: adminResponse.optional(adminResponse.record(adminResponse.string())),
    releaseNotes: adminResponse.optional(adminResponse.string()),
    upgradeGuide: adminResponse.optional(adminResponse.string()),
    deployedAt: adminResponse.optional(adminResponse.dateString()),
    deployedBy: adminResponse.optional(adminResponse.string()),
    deploymentDurationSeconds: adminResponse.optional(adminResponse.number()),
    deploymentEnvironments: adminResponse.optional(
      adminResponse.array(
        adminResponse.object({
          name: adminResponse.string(),
          deployedAt: adminResponse.dateString(),
          status: adminResponse.string(),
        }),
      ),
    ),
    isCurrentVersion: adminResponse.boolean(),
    previousVersion: adminResponse.optional(adminResponse.string()),
    rollbackInfo: adminResponse.optional(
      adminResponse.object({
        rolledBackAt: adminResponse.optional(adminResponse.dateString()),
        rolledBackBy: adminResponse.optional(adminResponse.string()),
        reason: adminResponse.optional(adminResponse.string()),
        targetVersion: adminResponse.optional(adminResponse.string()),
      }),
    ),
    metadata: adminResponse.optional(
      adminResponse.record(adminResponse.json('extension-metadata')),
    ),
    createdBy: adminResponse.optional(adminResponse.string()),
    createdAt: adminResponse.dateString(),
  }),
);

export type GlobalSettingsGetCurrentVersionResponseDto = AdminResponseProjection<
  typeof globalSettingsGetCurrentVersionResponseContract
>;

export const neverResponseContract = adminResponse.never();

export type NeverResponseDto = AdminResponseProjection<typeof neverResponseContract>;

export const globalSettingsGetProvisioningConfigResponseContract = adminResponse.object({
  provisioningApiUrl: adminResponse.string(),
  mqttBrokerHost: adminResponse.string(),
  mqttBrokerPort: adminResponse.number(),
  githubReleaseUrl: adminResponse.string(),
  agentDefaultVersion: adminResponse.string(),
  githubRepo: adminResponse.string(),
});

export type GlobalSettingsGetProvisioningConfigResponseDto = AdminResponseProjection<
  typeof globalSettingsGetProvisioningConfigResponseContract
>;

export const globalSettingsSystemHealthStatusContract = adminResponse.object({
  version: adminResponse.string(),
  uptime: adminResponse.number(),
  environment: adminResponse.string(),
  maintenanceMode: adminResponse.boolean(),
  featureToggles: adminResponse.number(),
  activeConfigs: adminResponse.number(),
});

export type GlobalSettingsSystemHealthStatusDto = AdminResponseProjection<
  typeof globalSettingsSystemHealthStatusContract
>;

export const jobQueueJobDashboardContract = adminResponse.object({
  totalJobs: adminResponse.number(),
  pendingJobs: adminResponse.number(),
  runningJobs: adminResponse.number(),
  failedJobs: adminResponse.number(),
  completedLast24h: adminResponse.number(),
  avgProcessingTime: adminResponse.number(),
  queueStats: adminResponse.array(
    adminResponse.object({
      queueName: adminResponse.string(),
      pending: adminResponse.number(),
      running: adminResponse.number(),
      completed: adminResponse.number(),
      failed: adminResponse.number(),
      avgProcessingTime: adminResponse.number(),
      throughput: adminResponse.number(),
    }),
  ),
  recentJobs: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      name: adminResponse.string(),
      queueName: adminResponse.string(),
      jobType: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('immediate'),
        adminResponse.literal('recurring'),
        adminResponse.literal('delayed'),
        adminResponse.literal('triggered'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('scheduled'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('retrying'),
        adminResponse.literal('paused'),
      ] as const),
      priority: adminResponse.number(),
      payload: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      progress: adminResponse.optional(
        adminResponse.object({
          current: adminResponse.number(),
          total: adminResponse.number(),
          percentage: adminResponse.number(),
          message: adminResponse.optional(adminResponse.string()),
          checkpoint: adminResponse.optional(adminResponse.json('job-payload')),
        }),
      ),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      scheduledAt: adminResponse.optional(adminResponse.dateString()),
      startedAt: adminResponse.optional(adminResponse.dateString()),
      completedAt: adminResponse.optional(adminResponse.dateString()),
      durationMs: adminResponse.optional(adminResponse.number()),
      attempts: adminResponse.number(),
      maxAttempts: adminResponse.number(),
      retryPolicy: adminResponse.optional(
        adminResponse.object({
          maxRetries: adminResponse.number(),
          retryDelay: adminResponse.number(),
          exponentialBackoff: adminResponse.boolean(),
          backoffMultiplier: adminResponse.optional(adminResponse.number()),
          maxDelay: adminResponse.optional(adminResponse.number()),
        }),
      ),
      nextRetryAt: adminResponse.optional(adminResponse.dateString()),
      cronExpression: adminResponse.optional(adminResponse.string()),
      lastRunAt: adminResponse.optional(adminResponse.dateString()),
      nextRunAt: adminResponse.optional(adminResponse.dateString()),
      timeoutMs: adminResponse.number(),
      dependencies: adminResponse.optional(adminResponse.array(adminResponse.string())),
      parentJobId: adminResponse.optional(adminResponse.string()),
      tags: adminResponse.optional(adminResponse.array(adminResponse.string())),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      workerId: adminResponse.optional(adminResponse.string()),
      isRecurring: adminResponse.boolean(),
      isPaused: adminResponse.boolean(),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  failedJobsList: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      name: adminResponse.string(),
      queueName: adminResponse.string(),
      jobType: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('immediate'),
        adminResponse.literal('recurring'),
        adminResponse.literal('delayed'),
        adminResponse.literal('triggered'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('scheduled'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('retrying'),
        adminResponse.literal('paused'),
      ] as const),
      priority: adminResponse.number(),
      payload: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      progress: adminResponse.optional(
        adminResponse.object({
          current: adminResponse.number(),
          total: adminResponse.number(),
          percentage: adminResponse.number(),
          message: adminResponse.optional(adminResponse.string()),
          checkpoint: adminResponse.optional(adminResponse.json('job-payload')),
        }),
      ),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      scheduledAt: adminResponse.optional(adminResponse.dateString()),
      startedAt: adminResponse.optional(adminResponse.dateString()),
      completedAt: adminResponse.optional(adminResponse.dateString()),
      durationMs: adminResponse.optional(adminResponse.number()),
      attempts: adminResponse.number(),
      maxAttempts: adminResponse.number(),
      retryPolicy: adminResponse.optional(
        adminResponse.object({
          maxRetries: adminResponse.number(),
          retryDelay: adminResponse.number(),
          exponentialBackoff: adminResponse.boolean(),
          backoffMultiplier: adminResponse.optional(adminResponse.number()),
          maxDelay: adminResponse.optional(adminResponse.number()),
        }),
      ),
      nextRetryAt: adminResponse.optional(adminResponse.dateString()),
      cronExpression: adminResponse.optional(adminResponse.string()),
      lastRunAt: adminResponse.optional(adminResponse.dateString()),
      nextRunAt: adminResponse.optional(adminResponse.dateString()),
      timeoutMs: adminResponse.number(),
      dependencies: adminResponse.optional(adminResponse.array(adminResponse.string())),
      parentJobId: adminResponse.optional(adminResponse.string()),
      tags: adminResponse.optional(adminResponse.array(adminResponse.string())),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      workerId: adminResponse.optional(adminResponse.string()),
      isRecurring: adminResponse.boolean(),
      isPaused: adminResponse.boolean(),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  scheduledJobs: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      name: adminResponse.string(),
      queueName: adminResponse.string(),
      jobType: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('immediate'),
        adminResponse.literal('recurring'),
        adminResponse.literal('delayed'),
        adminResponse.literal('triggered'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('scheduled'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('retrying'),
        adminResponse.literal('paused'),
      ] as const),
      priority: adminResponse.number(),
      payload: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      progress: adminResponse.optional(
        adminResponse.object({
          current: adminResponse.number(),
          total: adminResponse.number(),
          percentage: adminResponse.number(),
          message: adminResponse.optional(adminResponse.string()),
          checkpoint: adminResponse.optional(adminResponse.json('job-payload')),
        }),
      ),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      scheduledAt: adminResponse.optional(adminResponse.dateString()),
      startedAt: adminResponse.optional(adminResponse.dateString()),
      completedAt: adminResponse.optional(adminResponse.dateString()),
      durationMs: adminResponse.optional(adminResponse.number()),
      attempts: adminResponse.number(),
      maxAttempts: adminResponse.number(),
      retryPolicy: adminResponse.optional(
        adminResponse.object({
          maxRetries: adminResponse.number(),
          retryDelay: adminResponse.number(),
          exponentialBackoff: adminResponse.boolean(),
          backoffMultiplier: adminResponse.optional(adminResponse.number()),
          maxDelay: adminResponse.optional(adminResponse.number()),
        }),
      ),
      nextRetryAt: adminResponse.optional(adminResponse.dateString()),
      cronExpression: adminResponse.optional(adminResponse.string()),
      lastRunAt: adminResponse.optional(adminResponse.dateString()),
      nextRunAt: adminResponse.optional(adminResponse.dateString()),
      timeoutMs: adminResponse.number(),
      dependencies: adminResponse.optional(adminResponse.array(adminResponse.string())),
      parentJobId: adminResponse.optional(adminResponse.string()),
      tags: adminResponse.optional(adminResponse.array(adminResponse.string())),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      workerId: adminResponse.optional(adminResponse.string()),
      isRecurring: adminResponse.boolean(),
      isPaused: adminResponse.boolean(),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
});

export type JobQueueJobDashboardDto = AdminResponseProjection<typeof jobQueueJobDashboardContract>;

export const jobQueueJobQueueContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  isActive: adminResponse.boolean(),
  isPaused: adminResponse.boolean(),
  concurrency: adminResponse.number(),
  maxJobsPerSecond: adminResponse.number(),
  defaultMaxRetries: adminResponse.number(),
  defaultTimeoutMs: adminResponse.number(),
  retryPolicy: adminResponse.optional(
    adminResponse.object({
      maxRetries: adminResponse.number(),
      retryDelay: adminResponse.number(),
      exponentialBackoff: adminResponse.boolean(),
      backoffMultiplier: adminResponse.optional(adminResponse.number()),
      maxDelay: adminResponse.optional(adminResponse.number()),
    }),
  ),
  pendingCount: adminResponse.number(),
  runningCount: adminResponse.number(),
  completedCount: adminResponse.number(),
  failedCount: adminResponse.number(),
  avgProcessingTimeMs: adminResponse.optional(adminResponse.number()),
  lastJobAt: adminResponse.optional(adminResponse.dateString()),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type JobQueueJobQueueDto = AdminResponseProjection<typeof jobQueueJobQueueContract>;

export const jobQueueJobQueueStatsContract = adminResponse.object({
  queueName: adminResponse.string(),
  pending: adminResponse.number(),
  running: adminResponse.number(),
  completed: adminResponse.number(),
  failed: adminResponse.number(),
  avgProcessingTime: adminResponse.number(),
  throughput: adminResponse.number(),
});

export type JobQueueJobQueueStatsDto = AdminResponseProjection<
  typeof jobQueueJobQueueStatsContract
>;

export const jobQueueBackgroundJobContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  queueName: adminResponse.string(),
  jobType: adminResponse.union([
    adminResponse.literal('scheduled'),
    adminResponse.literal('immediate'),
    adminResponse.literal('recurring'),
    adminResponse.literal('delayed'),
    adminResponse.literal('triggered'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('pending'),
    adminResponse.literal('scheduled'),
    adminResponse.literal('running'),
    adminResponse.literal('completed'),
    adminResponse.literal('failed'),
    adminResponse.literal('cancelled'),
    adminResponse.literal('retrying'),
    adminResponse.literal('paused'),
  ] as const),
  priority: adminResponse.number(),
  payload: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
  result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
  errorMessage: adminResponse.optional(adminResponse.string()),
  progress: adminResponse.optional(
    adminResponse.object({
      current: adminResponse.number(),
      total: adminResponse.number(),
      percentage: adminResponse.number(),
      message: adminResponse.optional(adminResponse.string()),
    }),
  ),
  scheduledAt: adminResponse.optional(adminResponse.dateString()),
  startedAt: adminResponse.optional(adminResponse.dateString()),
  completedAt: adminResponse.optional(adminResponse.dateString()),
  durationMs: adminResponse.optional(adminResponse.number()),
  attempts: adminResponse.number(),
  maxAttempts: adminResponse.number(),
  cronExpression: adminResponse.optional(adminResponse.string()),
  nextRunAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
});

export type JobQueueBackgroundJobDto = AdminResponseProjection<
  typeof jobQueueBackgroundJobContract
>;

export const jobQueueQueryJobsResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      name: adminResponse.string(),
      queueName: adminResponse.string(),
      jobType: adminResponse.union([
        adminResponse.literal('scheduled'),
        adminResponse.literal('immediate'),
        adminResponse.literal('recurring'),
        adminResponse.literal('delayed'),
        adminResponse.literal('triggered'),
      ] as const),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('scheduled'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('retrying'),
        adminResponse.literal('paused'),
      ] as const),
      priority: adminResponse.number(),
      payload: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      progress: adminResponse.optional(
        adminResponse.object({
          current: adminResponse.number(),
          total: adminResponse.number(),
          percentage: adminResponse.number(),
          message: adminResponse.optional(adminResponse.string()),
          checkpoint: adminResponse.optional(adminResponse.json('job-payload')),
        }),
      ),
      tenantId: adminResponse.optional(adminResponse.string()),
      userId: adminResponse.optional(adminResponse.string()),
      scheduledAt: adminResponse.optional(adminResponse.dateString()),
      startedAt: adminResponse.optional(adminResponse.dateString()),
      completedAt: adminResponse.optional(adminResponse.dateString()),
      durationMs: adminResponse.optional(adminResponse.number()),
      attempts: adminResponse.number(),
      maxAttempts: adminResponse.number(),
      retryPolicy: adminResponse.optional(
        adminResponse.object({
          maxRetries: adminResponse.number(),
          retryDelay: adminResponse.number(),
          exponentialBackoff: adminResponse.boolean(),
          backoffMultiplier: adminResponse.optional(adminResponse.number()),
          maxDelay: adminResponse.optional(adminResponse.number()),
        }),
      ),
      nextRetryAt: adminResponse.optional(adminResponse.dateString()),
      cronExpression: adminResponse.optional(adminResponse.string()),
      lastRunAt: adminResponse.optional(adminResponse.dateString()),
      nextRunAt: adminResponse.optional(adminResponse.dateString()),
      timeoutMs: adminResponse.number(),
      dependencies: adminResponse.optional(adminResponse.array(adminResponse.string())),
      parentJobId: adminResponse.optional(adminResponse.string()),
      tags: adminResponse.optional(adminResponse.array(adminResponse.string())),
      metadata: adminResponse.optional(
        adminResponse.record(adminResponse.json('extension-metadata')),
      ),
      workerId: adminResponse.optional(adminResponse.string()),
      isRecurring: adminResponse.boolean(),
      isPaused: adminResponse.boolean(),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type JobQueueQueryJobsResponseDto = AdminResponseProjection<
  typeof jobQueueQueryJobsResponseContract
>;

export const jobQueueGetJobLogsResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      jobId: adminResponse.string(),
      attemptNumber: adminResponse.number(),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('scheduled'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('retrying'),
        adminResponse.literal('paused'),
      ] as const),
      startedAt: adminResponse.dateString(),
      completedAt: adminResponse.optional(adminResponse.dateString()),
      durationMs: adminResponse.optional(adminResponse.number()),
      errorMessage: adminResponse.optional(adminResponse.string()),
      stackTrace: adminResponse.optional(adminResponse.string()),
      result: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
      logs: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            level: adminResponse.union([
              adminResponse.literal('info'),
              adminResponse.literal('warn'),
              adminResponse.literal('debug'),
              adminResponse.literal('error'),
            ] as const),
            message: adminResponse.string(),
            timestamp: adminResponse.dateString(),
            data: adminResponse.optional(adminResponse.record(adminResponse.json('job-payload'))),
          }),
        ),
      ),
      workerId: adminResponse.optional(adminResponse.string()),
      cpuUsage: adminResponse.optional(adminResponse.number()),
      memoryUsage: adminResponse.optional(adminResponse.number()),
      timestamp: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type JobQueueGetJobLogsResponseDto = AdminResponseProjection<
  typeof jobQueueGetJobLogsResponseContract
>;

export const jobQueueRetryFailedJobsResponseContract = adminResponse.object({
  retriedCount: adminResponse.number(),
});

export type JobQueueRetryFailedJobsResponseDto = AdminResponseProjection<
  typeof jobQueueRetryFailedJobsResponseContract
>;

export const jobQueuePurgeCompletedJobsResponseContract = adminResponse.object({
  purgedCount: adminResponse.number(),
});

export type JobQueuePurgeCompletedJobsResponseDto = AdminResponseProjection<
  typeof jobQueuePurgeCompletedJobsResponseContract
>;

export const performancePerformanceDashboardContract = adminResponse.object({
  currentSnapshot: adminResponse.nullable(
    adminResponse.object({
      id: adminResponse.string(),
      service: adminResponse.optional(adminResponse.string()),
      timestamp: adminResponse.dateString(),
      applicationMetrics: adminResponse.object({
        avgResponseTime: adminResponse.number(),
        p95ResponseTime: adminResponse.number(),
        p99ResponseTime: adminResponse.number(),
        throughput: adminResponse.number(),
        errorRate: adminResponse.number(),
        apdexScore: adminResponse.number(),
        activeRequests: adminResponse.number(),
        totalRequests: adminResponse.number(),
      }),
      databaseMetrics: adminResponse.object({
        activeConnections: adminResponse.number(),
        poolSize: adminResponse.number(),
        poolUtilization: adminResponse.number(),
        avgQueryTime: adminResponse.number(),
        slowQueryCount: adminResponse.number(),
        cacheHitRatio: adminResponse.number(),
        deadlockCount: adminResponse.number(),
      }),
      infrastructureMetrics: adminResponse.object({
        cpuUsage: adminResponse.number(),
        memoryUsage: adminResponse.number(),
        memoryTotal: adminResponse.number(),
        diskUsage: adminResponse.number(),
        diskTotal: adminResponse.number(),
        networkLatency: adminResponse.number(),
        containerCount: adminResponse.number(),
        healthyContainers: adminResponse.number(),
        podRestarts: adminResponse.number(),
      }),
      alerts: adminResponse.optional(
        adminResponse.array(
          adminResponse.object({
            metric: adminResponse.string(),
            threshold: adminResponse.number(),
            currentValue: adminResponse.number(),
            severity: adminResponse.union([
              adminResponse.literal('warning'),
              adminResponse.literal('critical'),
            ] as const),
          }),
        ),
      ),
      overallHealthScore: adminResponse.optional(adminResponse.number()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  trends: adminResponse.object({
    responseTime: adminResponse.array(
      adminResponse.object({
        timestamp: adminResponse.dateString(),
        value: adminResponse.number(),
      }),
    ),
    throughput: adminResponse.array(
      adminResponse.object({
        timestamp: adminResponse.dateString(),
        value: adminResponse.number(),
      }),
    ),
    errorRate: adminResponse.array(
      adminResponse.object({
        timestamp: adminResponse.dateString(),
        value: adminResponse.number(),
      }),
    ),
    cpuUsage: adminResponse.array(
      adminResponse.object({
        timestamp: adminResponse.dateString(),
        value: adminResponse.number(),
      }),
    ),
    memoryUsage: adminResponse.array(
      adminResponse.object({
        timestamp: adminResponse.dateString(),
        value: adminResponse.number(),
      }),
    ),
  }),
  alerts: adminResponse.array(
    adminResponse.object({
      metric: adminResponse.string(),
      threshold: adminResponse.number(),
      currentValue: adminResponse.number(),
      severity: adminResponse.union([
        adminResponse.literal('warning'),
        adminResponse.literal('critical'),
      ] as const),
    }),
  ),
  healthScore: adminResponse.number(),
  serviceBreakdown: adminResponse.array(
    adminResponse.object({
      service: adminResponse.string(),
      avgResponseTime: adminResponse.number(),
      errorRate: adminResponse.number(),
      requestCount: adminResponse.number(),
    }),
  ),
});

export type PerformancePerformanceDashboardDto = AdminResponseProjection<
  typeof performancePerformanceDashboardContract
>;

export const performanceApplicationMetricsContract = adminResponse.object({
  avgResponseTime: adminResponse.number(),
  p95ResponseTime: adminResponse.number(),
  p99ResponseTime: adminResponse.number(),
  throughput: adminResponse.number(),
  errorRate: adminResponse.number(),
  apdexScore: adminResponse.number(),
  activeRequests: adminResponse.number(),
  totalRequests: adminResponse.number(),
});

export type PerformanceApplicationMetricsDto = AdminResponseProjection<
  typeof performanceApplicationMetricsContract
>;

export const performanceGetApdexScoreResponseContract = adminResponse.object({
  apdexScore: adminResponse.number(),
});

export type PerformanceGetApdexScoreResponseDto = AdminResponseProjection<
  typeof performanceGetApdexScoreResponseContract
>;

export const performanceDatabaseMetricsContract = adminResponse.object({
  activeConnections: adminResponse.number(),
  poolSize: adminResponse.number(),
  poolUtilization: adminResponse.number(),
  avgQueryTime: adminResponse.number(),
  slowQueryCount: adminResponse.number(),
  cacheHitRatio: adminResponse.number(),
  deadlockCount: adminResponse.number(),
});

export type PerformanceDatabaseMetricsDto = AdminResponseProjection<
  typeof performanceDatabaseMetricsContract
>;

export const performanceGetSlowQueriesResponseContract = adminResponse.object({
  query: adminResponse.string(),
  avgTime: adminResponse.number(),
  count: adminResponse.number(),
  maxTime: adminResponse.number(),
});

export type PerformanceGetSlowQueriesResponseDto = AdminResponseProjection<
  typeof performanceGetSlowQueriesResponseContract
>;

export const performanceInfrastructureMetricsContract = adminResponse.object({
  cpuUsage: adminResponse.number(),
  memoryUsage: adminResponse.number(),
  memoryTotal: adminResponse.number(),
  diskUsage: adminResponse.number(),
  diskTotal: adminResponse.number(),
  networkLatency: adminResponse.number(),
  containerCount: adminResponse.number(),
  healthyContainers: adminResponse.number(),
  podRestarts: adminResponse.number(),
});

export type PerformanceInfrastructureMetricsDto = AdminResponseProjection<
  typeof performanceInfrastructureMetricsContract
>;

export const performanceGetServiceBreakdownResponseContract = adminResponse.object({
  service: adminResponse.string(),
  avgResponseTime: adminResponse.number(),
  errorRate: adminResponse.number(),
  requestCount: adminResponse.number(),
});

export type PerformanceGetServiceBreakdownResponseDto = AdminResponseProjection<
  typeof performanceGetServiceBreakdownResponseContract
>;

export const performanceCheckThresholdsResponseContract = adminResponse.object({
  metric: adminResponse.string(),
  threshold: adminResponse.number(),
  currentValue: adminResponse.number(),
  severity: adminResponse.union([
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
  ] as const),
});

export type PerformanceCheckThresholdsResponseDto = AdminResponseProjection<
  typeof performanceCheckThresholdsResponseContract
>;

export const performanceMetricThresholdContract = adminResponse.object({
  metric: adminResponse.union([
    adminResponse.literal('response_time'),
    adminResponse.literal('throughput'),
    adminResponse.literal('error_rate'),
    adminResponse.literal('apdex'),
    adminResponse.literal('active_users'),
    adminResponse.literal('request_count'),
    adminResponse.literal('db_connection_pool'),
    adminResponse.literal('db_query_time'),
    adminResponse.literal('db_cache_hit_ratio'),
    adminResponse.literal('db_deadlocks'),
    adminResponse.literal('db_active_connections'),
    adminResponse.literal('db_slow_queries'),
    adminResponse.literal('cpu_usage'),
    adminResponse.literal('memory_usage'),
    adminResponse.literal('disk_usage'),
    adminResponse.literal('network_latency'),
    adminResponse.literal('container_health'),
    adminResponse.literal('pod_restarts'),
    adminResponse.literal('custom'),
  ] as const),
  warningThreshold: adminResponse.number(),
  criticalThreshold: adminResponse.number(),
  comparison: adminResponse.union([
    adminResponse.literal('gt'),
    adminResponse.literal('lt'),
    adminResponse.literal('gte'),
    adminResponse.literal('lte'),
  ] as const),
});

export type PerformanceMetricThresholdDto = AdminResponseProjection<
  typeof performanceMetricThresholdContract
>;

export const performanceUpdateThresholdsResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
});

export type PerformanceUpdateThresholdsResponseDto = AdminResponseProjection<
  typeof performanceUpdateThresholdsResponseContract
>;

export const performanceGetMetricHistoryResponseContract = adminResponse.object({
  timestamp: adminResponse.dateString(),
  value: adminResponse.number(),
  min: adminResponse.optional(adminResponse.number()),
  max: adminResponse.optional(adminResponse.number()),
});

export type PerformanceGetMetricHistoryResponseDto = AdminResponseProjection<
  typeof performanceGetMetricHistoryResponseContract
>;

export const performancePerformanceSnapshotContract = adminResponse.object({
  id: adminResponse.string(),
  service: adminResponse.optional(adminResponse.string()),
  timestamp: adminResponse.dateString(),
  applicationMetrics: adminResponse.object({
    avgResponseTime: adminResponse.number(),
    p95ResponseTime: adminResponse.number(),
    p99ResponseTime: adminResponse.number(),
    throughput: adminResponse.number(),
    errorRate: adminResponse.number(),
    apdexScore: adminResponse.number(),
    activeRequests: adminResponse.number(),
    totalRequests: adminResponse.number(),
  }),
  databaseMetrics: adminResponse.object({
    activeConnections: adminResponse.number(),
    poolSize: adminResponse.number(),
    poolUtilization: adminResponse.number(),
    avgQueryTime: adminResponse.number(),
    slowQueryCount: adminResponse.number(),
    cacheHitRatio: adminResponse.number(),
    deadlockCount: adminResponse.number(),
  }),
  infrastructureMetrics: adminResponse.object({
    cpuUsage: adminResponse.number(),
    memoryUsage: adminResponse.number(),
    memoryTotal: adminResponse.number(),
    diskUsage: adminResponse.number(),
    diskTotal: adminResponse.number(),
    networkLatency: adminResponse.number(),
    containerCount: adminResponse.number(),
    healthyContainers: adminResponse.number(),
    podRestarts: adminResponse.number(),
  }),
  alerts: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        metric: adminResponse.string(),
        threshold: adminResponse.number(),
        currentValue: adminResponse.number(),
        severity: adminResponse.union([
          adminResponse.literal('warning'),
          adminResponse.literal('critical'),
        ] as const),
      }),
    ),
  ),
  overallHealthScore: adminResponse.optional(adminResponse.number()),
  createdAt: adminResponse.dateString(),
});

export type PerformancePerformanceSnapshotDto = AdminResponseProjection<
  typeof performancePerformanceSnapshotContract
>;

export const performanceRecordMetricResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
});

export type PerformanceRecordMetricResponseDto = AdminResponseProjection<
  typeof performanceRecordMetricResponseContract
>;

export const performanceRecordRequestMetricResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
});

export type PerformanceRecordRequestMetricResponseDto = AdminResponseProjection<
  typeof performanceRecordRequestMetricResponseContract
>;

export const performanceFlushMetricsResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
});

export type PerformanceFlushMetricsResponseDto = AdminResponseProjection<
  typeof performanceFlushMetricsResponseContract
>;

export const errorTrackingErrorAlertRuleArrayContract = adminResponse.array(
  errorTrackingErrorAlertRuleContract,
);

export const errorTrackingGetErrorStatsResponseArrayContract = adminResponse.array(
  errorTrackingGetErrorStatsResponseContract,
);

export const jobQueueJobQueueArrayContract = adminResponse.array(jobQueueJobQueueContract);

export const performanceCheckThresholdsResponseArrayContract = adminResponse.array(
  performanceCheckThresholdsResponseContract,
);

export const performanceGetMetricHistoryResponseArrayContract = adminResponse.array(
  performanceGetMetricHistoryResponseContract,
);

export const performanceGetServiceBreakdownResponseArrayContract = adminResponse.array(
  performanceGetServiceBreakdownResponseContract,
);

export const performanceGetSlowQueriesResponseArrayContract = adminResponse.array(
  performanceGetSlowQueriesResponseContract,
);

export const performanceMetricThresholdArrayContract = adminResponse.array(
  performanceMetricThresholdContract,
);

export const performancePerformanceSnapshotArrayContract = adminResponse.array(
  performancePerformanceSnapshotContract,
);
