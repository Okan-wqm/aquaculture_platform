import {
  adminManualResponse,
  adminResponse,
  type AdminResponseProjection,
} from '@platform/admin-http-contracts';

export const auditTrailExportProfile = adminManualResponse.binary(
  [200],
  ['application/json', 'application/pdf', 'text/csv'],
  33_554_432,
);

export const activityLogActivityLogDtoContract = adminResponse.object({
  id: adminResponse.string(),
  category: adminResponse.union([
    adminResponse.literal('configuration'),
    adminResponse.literal('user_action'),
    adminResponse.literal('system_event'),
    adminResponse.literal('api_call'),
    adminResponse.literal('data_access'),
    adminResponse.literal('security_event'),
    adminResponse.literal('authentication'),
  ] as const),
  action: adminResponse.string(),
  severity: adminResponse.union([
    adminResponse.literal('info'),
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
    adminResponse.literal('debug'),
    adminResponse.literal('error'),
  ] as const),
  tenantId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  tenantName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userEmail: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  ipAddress: adminResponse.string(),
  userAgent: adminResponse.optional(adminResponse.string()),
  geoLocation: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        country: adminResponse.string(),
        countryCode: adminResponse.string(),
        region: adminResponse.string(),
        city: adminResponse.string(),
        latitude: adminResponse.number(),
        longitude: adminResponse.number(),
        timezone: adminResponse.string(),
      }),
    ),
  ),
  entityType: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  entityId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  entityName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  previousValue: adminResponse.optional(
    adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
  ),
  newValue: adminResponse.optional(
    adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
  ),
  metadata: adminResponse.optional(
    adminResponse.nullable(adminResponse.record(adminResponse.json('extension-metadata'))),
  ),
  duration: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  errorMessage: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
});

export type ActivityLogActivityLogDtoDto = AdminResponseProjection<
  typeof activityLogActivityLogDtoContract
>;

export const activityLogGetActivityResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    category: adminResponse.union([
      adminResponse.literal('configuration'),
      adminResponse.literal('user_action'),
      adminResponse.literal('system_event'),
      adminResponse.literal('api_call'),
      adminResponse.literal('data_access'),
      adminResponse.literal('security_event'),
      adminResponse.literal('authentication'),
    ] as const),
    action: adminResponse.string(),
    severity: adminResponse.union([
      adminResponse.literal('info'),
      adminResponse.literal('warning'),
      adminResponse.literal('critical'),
      adminResponse.literal('debug'),
      adminResponse.literal('error'),
    ] as const),
    tenantId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    tenantName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    userId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    userName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    userEmail: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    ipAddress: adminResponse.string(),
    userAgent: adminResponse.optional(adminResponse.string()),
    geoLocation: adminResponse.optional(
      adminResponse.nullable(
        adminResponse.object({
          country: adminResponse.string(),
          countryCode: adminResponse.string(),
          region: adminResponse.string(),
          city: adminResponse.string(),
          latitude: adminResponse.number(),
          longitude: adminResponse.number(),
          timezone: adminResponse.string(),
        }),
      ),
    ),
    entityType: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    entityId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    entityName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    previousValue: adminResponse.optional(
      adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
    ),
    newValue: adminResponse.optional(
      adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
    ),
    metadata: adminResponse.optional(
      adminResponse.nullable(adminResponse.record(adminResponse.json('extension-metadata'))),
    ),
    duration: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
    success: adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    errorMessage: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    createdAt: adminResponse.dateString(),
  }),
);

export type ActivityLogGetActivityResponseDto = AdminResponseProjection<
  typeof activityLogGetActivityResponseContract
>;

export const activityLogLogActivityResponseContract = adminResponse.object({
  success: adminResponse.literal(true),
});

export type ActivityLogLogActivityResponseDto = AdminResponseProjection<
  typeof activityLogLogActivityResponseContract
>;

export const activityLogActivityStatsDtoContract = adminResponse.object({
  totalActivities: adminResponse.number(),
  byCategory: adminResponse.object({
    user_action: adminResponse.number(),
    system_event: adminResponse.number(),
    api_call: adminResponse.number(),
    data_access: adminResponse.number(),
    security_event: adminResponse.number(),
    configuration: adminResponse.number(),
    authentication: adminResponse.number(),
  }),
  bySeverity: adminResponse.object({
    debug: adminResponse.number(),
    info: adminResponse.number(),
    warning: adminResponse.number(),
    error: adminResponse.number(),
    critical: adminResponse.number(),
  }),
  bySuccess: adminResponse.object({
    success: adminResponse.number(),
    failure: adminResponse.number(),
  }),
  topActions: adminResponse.array(
    adminResponse.object({
      action: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  topUsers: adminResponse.array(
    adminResponse.object({
      userId: adminResponse.string(),
      userName: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  topIPs: adminResponse.array(
    adminResponse.object({
      ip: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  activityOverTime: adminResponse.array(
    adminResponse.object({
      date: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
});

export type ActivityLogActivityStatsDtoDto = AdminResponseProjection<
  typeof activityLogActivityStatsDtoContract
>;

export const activityLogLoginAttemptDtoContract = adminResponse.object({
  id: adminResponse.string(),
  email: adminResponse.string(),
  ipAddress: adminResponse.string(),
  success: adminResponse.boolean(),
  failureReason: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  geoLocation: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        country: adminResponse.string(),
        countryCode: adminResponse.string(),
        region: adminResponse.string(),
        city: adminResponse.string(),
        latitude: adminResponse.number(),
        longitude: adminResponse.number(),
        timezone: adminResponse.string(),
      }),
    ),
  ),
  deviceInfo: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        userAgent: adminResponse.string(),
        browser: adminResponse.string(),
        browserVersion: adminResponse.string(),
        os: adminResponse.string(),
        osVersion: adminResponse.string(),
        device: adminResponse.string(),
        deviceType: adminResponse.union([
          adminResponse.literal('desktop'),
          adminResponse.literal('mobile'),
          adminResponse.literal('tablet'),
          adminResponse.literal('bot'),
          adminResponse.literal('unknown'),
        ] as const),
        isMobile: adminResponse.boolean(),
        isBot: adminResponse.boolean(),
      }),
    ),
  ),
  tenantId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  sessionId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
});

export type ActivityLogLoginAttemptDtoDto = AdminResponseProjection<
  typeof activityLogLoginAttemptDtoContract
>;

export const activityLogUserSessionDtoContract = adminResponse.object({
  id: adminResponse.string(),
  userId: adminResponse.string(),
  userName: adminResponse.string(),
  tenantId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  tenantName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  isActive: adminResponse.boolean(),
  expiresAt: adminResponse.dateString(),
  ipAddress: adminResponse.string(),
  geoLocation: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        country: adminResponse.string(),
        countryCode: adminResponse.string(),
        region: adminResponse.string(),
        city: adminResponse.string(),
        latitude: adminResponse.number(),
        longitude: adminResponse.number(),
        timezone: adminResponse.string(),
      }),
    ),
  ),
  deviceInfo: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        userAgent: adminResponse.string(),
        browser: adminResponse.string(),
        browserVersion: adminResponse.string(),
        os: adminResponse.string(),
        osVersion: adminResponse.string(),
        device: adminResponse.string(),
        deviceType: adminResponse.union([
          adminResponse.literal('desktop'),
          adminResponse.literal('mobile'),
          adminResponse.literal('tablet'),
          adminResponse.literal('bot'),
          adminResponse.literal('unknown'),
        ] as const),
        isMobile: adminResponse.boolean(),
        isBot: adminResponse.boolean(),
      }),
    ),
  ),
  requestCount: adminResponse.number(),
  lastActivityAt: adminResponse.dateString(),
  lastActivityPath: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  terminatedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  terminationReason: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.union([
        adminResponse.literal('expired'),
        adminResponse.literal('logout'),
        adminResponse.literal('forced'),
        adminResponse.literal('security'),
      ] as const),
    ),
  ),
  terminatedBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ActivityLogUserSessionDtoDto = AdminResponseProjection<
  typeof activityLogUserSessionDtoContract
>;

export const activityLogTerminateUserSessionsResponseContract = adminResponse.object({
  terminated: adminResponse.number(),
});

export type ActivityLogTerminateUserSessionsResponseDto = AdminResponseProjection<
  typeof activityLogTerminateUserSessionsResponseContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const auditTrailRetentionPolicyDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  category: adminResponse.union([
    adminResponse.literal('configuration'),
    adminResponse.literal('user_action'),
    adminResponse.literal('system_event'),
    adminResponse.literal('api_call'),
    adminResponse.literal('data_access'),
    adminResponse.literal('security_event'),
    adminResponse.literal('authentication'),
  ] as const),
  description: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  retentionDays: adminResponse.number(),
  archiveAfterDays: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
  deleteAfterArchiveDays: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
  isGlobal: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  specificTenants: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  complianceFrameworks: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.array(
        adminResponse.union([
          adminResponse.literal('gdpr'),
          adminResponse.literal('ccpa'),
          adminResponse.literal('hipaa'),
          adminResponse.literal('pci_dss'),
          adminResponse.literal('sox'),
          adminResponse.literal('iso27001'),
        ] as const),
      ),
    ),
  ),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdBy: adminResponse.string(),
  updatedBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type AuditTrailRetentionPolicyDtoDto = AdminResponseProjection<
  typeof auditTrailRetentionPolicyDtoContract
>;

export const auditTrailRetentionStatsDtoContract = adminResponse.object({
  totalLogs: adminResponse.number(),
  activeLogs: adminResponse.number(),
  archivedLogs: adminResponse.number(),
  oldestLog: adminResponse.nullable(adminResponse.dateString()),
  newestLog: adminResponse.nullable(adminResponse.dateString()),
  storageEstimateMB: adminResponse.number(),
  byCategory: adminResponse.record(
    adminResponse.object({
      active: adminResponse.number(),
      archived: adminResponse.number(),
    }),
  ),
});

export type AuditTrailRetentionStatsDtoDto = AdminResponseProjection<
  typeof auditTrailRetentionStatsDtoContract
>;

export const auditTrailOperationSuccessDtoContract = adminResponse.object({
  success: adminResponse.literal(true),
});

export type AuditTrailOperationSuccessDtoDto = AdminResponseProjection<
  typeof auditTrailOperationSuccessDtoContract
>;

export const auditTrailAuditAlertRuleDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.string(),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  conditions: adminResponse.object({
    category: adminResponse.optional(
      adminResponse.array(
        adminResponse.union([
          adminResponse.literal('configuration'),
          adminResponse.literal('user_action'),
          adminResponse.literal('system_event'),
          adminResponse.literal('api_call'),
          adminResponse.literal('data_access'),
          adminResponse.literal('security_event'),
          adminResponse.literal('authentication'),
        ] as const),
      ),
    ),
    severity: adminResponse.optional(
      adminResponse.array(
        adminResponse.union([
          adminResponse.literal('info'),
          adminResponse.literal('warning'),
          adminResponse.literal('critical'),
          adminResponse.literal('debug'),
          adminResponse.literal('error'),
        ] as const),
      ),
    ),
    actions: adminResponse.optional(adminResponse.array(adminResponse.string())),
    entityTypes: adminResponse.optional(adminResponse.array(adminResponse.string())),
    successOnly: adminResponse.optional(
      adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
    ),
    failureOnly: adminResponse.optional(
      adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
    ),
    ipPatterns: adminResponse.optional(adminResponse.array(adminResponse.string())),
  }),
  alertChannels: adminResponse.array(
    adminResponse.union([
      adminResponse.literal('email'),
      adminResponse.literal('webhook'),
      adminResponse.literal('slack'),
      adminResponse.literal('sms'),
    ] as const),
  ),
  recipients: adminResponse.array(adminResponse.string()),
  cooldownMinutes: adminResponse.number(),
  lastTriggeredAt: adminResponse.optional(adminResponse.dateString()),
});

export type AuditTrailAuditAlertRuleDtoDto = AdminResponseProjection<
  typeof auditTrailAuditAlertRuleDtoContract
>;

export const auditTrailUpdateAlertRuleResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    name: adminResponse.string(),
    description: adminResponse.string(),
    isActive: adminResponse.boolean(),
    conditions: adminResponse.object({
      category: adminResponse.optional(
        adminResponse.array(
          adminResponse.union([
            adminResponse.literal('configuration'),
            adminResponse.literal('user_action'),
            adminResponse.literal('system_event'),
            adminResponse.literal('api_call'),
            adminResponse.literal('data_access'),
            adminResponse.literal('security_event'),
            adminResponse.literal('authentication'),
          ] as const),
        ),
      ),
      severity: adminResponse.optional(
        adminResponse.array(
          adminResponse.union([
            adminResponse.literal('info'),
            adminResponse.literal('warning'),
            adminResponse.literal('critical'),
            adminResponse.literal('debug'),
            adminResponse.literal('error'),
          ] as const),
        ),
      ),
      actions: adminResponse.optional(adminResponse.array(adminResponse.string())),
      entityTypes: adminResponse.optional(adminResponse.array(adminResponse.string())),
      successOnly: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
      failureOnly: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
      ipPatterns: adminResponse.optional(adminResponse.array(adminResponse.string())),
    }),
    alertChannels: adminResponse.array(
      adminResponse.union([
        adminResponse.literal('email'),
        adminResponse.literal('webhook'),
        adminResponse.literal('slack'),
        adminResponse.literal('sms'),
      ] as const),
    ),
    recipients: adminResponse.array(adminResponse.string()),
    cooldownMinutes: adminResponse.number(),
    lastTriggeredAt: adminResponse.optional(adminResponse.dateString()),
  }),
);

export type AuditTrailUpdateAlertRuleResponseDto = AdminResponseProjection<
  typeof auditTrailUpdateAlertRuleResponseContract
>;

export const complianceDataRequestDtoContract = adminResponse.object({
  id: adminResponse.string(),
  requestNumber: adminResponse.string(),
  requestType: adminResponse.union([
    adminResponse.literal('access'),
    adminResponse.literal('deletion'),
    adminResponse.literal('portability'),
    adminResponse.literal('rectification'),
    adminResponse.literal('restriction'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('pending'),
    adminResponse.literal('completed'),
    adminResponse.literal('in_progress'),
    adminResponse.literal('expired'),
    adminResponse.literal('rejected'),
  ] as const),
  complianceFramework: adminResponse.union([
    adminResponse.literal('gdpr'),
    adminResponse.literal('ccpa'),
    adminResponse.literal('hipaa'),
    adminResponse.literal('pci_dss'),
    adminResponse.literal('sox'),
    adminResponse.literal('iso27001'),
  ] as const),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.string(),
  requesterId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  requesterName: adminResponse.string(),
  requesterEmail: adminResponse.string(),
  description: adminResponse.string(),
  dataCategories: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  specificData: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  identityVerified: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  verifiedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  verifiedBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  verificationMethod: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  dueDate: adminResponse.dateString(),
  assignedTo: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  assignedToName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  processingStartedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  completedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  completedBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  completionNotes: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  deliveryFormat: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.union([
        adminResponse.literal('json'),
        adminResponse.literal('csv'),
        adminResponse.literal('pdf'),
        adminResponse.literal('xml'),
      ] as const),
    ),
  ),
  downloadUrl: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  downloadExpiresAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  downloadCount: adminResponse.number(),
  rejectionReason: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ComplianceDataRequestDtoDto = AdminResponseProjection<
  typeof complianceDataRequestDtoContract
>;

export const complianceRecordDownloadResponseContract = adminResponse.object({
  success: adminResponse.literal(true),
});

export type ComplianceRecordDownloadResponseDto = AdminResponseProjection<
  typeof complianceRecordDownloadResponseContract
>;

export const complianceDataRequestStatsDtoContract = adminResponse.object({
  total: adminResponse.number(),
  byStatus: adminResponse.object({
    pending: adminResponse.number(),
    completed: adminResponse.number(),
    in_progress: adminResponse.number(),
    expired: adminResponse.number(),
    rejected: adminResponse.number(),
  }),
  byType: adminResponse.object({
    access: adminResponse.number(),
    deletion: adminResponse.number(),
    portability: adminResponse.number(),
    rectification: adminResponse.number(),
    restriction: adminResponse.number(),
  }),
  avgResponseDays: adminResponse.number(),
  overdueCount: adminResponse.number(),
  completionRate: adminResponse.number(),
});

export type ComplianceDataRequestStatsDtoDto = AdminResponseProjection<
  typeof complianceDataRequestStatsDtoContract
>;

export const complianceComplianceReportDtoContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  complianceType: adminResponse.union([
    adminResponse.literal('gdpr'),
    adminResponse.literal('ccpa'),
    adminResponse.literal('hipaa'),
    adminResponse.literal('pci_dss'),
    adminResponse.literal('sox'),
    adminResponse.literal('iso27001'),
  ] as const),
  reportPeriodStart: adminResponse.dateString(),
  reportPeriodEnd: adminResponse.dateString(),
  includedTenants: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  includesAllTenants: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  totalDataRequests: adminResponse.number(),
  completedDataRequests: adminResponse.number(),
  pendingDataRequests: adminResponse.number(),
  avgResponseTimeDays: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
  securityIncidents: adminResponse.number(),
  dataBreaches: adminResponse.number(),
  complianceScore: adminResponse.number(),
  violations: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.array(
        adminResponse.object({
          requirement: adminResponse.string(),
          description: adminResponse.string(),
          severity: adminResponse.union([
            adminResponse.literal('critical'),
            adminResponse.literal('high'),
            adminResponse.literal('medium'),
            adminResponse.literal('low'),
          ] as const),
          remediation: adminResponse.string(),
          deadline: adminResponse.optional(adminResponse.dateString()),
        }),
      ),
    ),
  ),
  recommendations: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  executiveSummary: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  detailedFindings: adminResponse.optional(
    adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
  ),
  pdfUrl: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  csvUrl: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  generatedBy: adminResponse.string(),
  generatedByName: adminResponse.string(),
  isAutoGenerated: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ComplianceComplianceReportDtoDto = AdminResponseProjection<
  typeof complianceComplianceReportDtoContract
>;

export const complianceComplianceCheckResultDtoContract = adminResponse.object({
  requirement: adminResponse.object({
    id: adminResponse.string(),
    framework: adminResponse.union([
      adminResponse.literal('gdpr'),
      adminResponse.literal('ccpa'),
      adminResponse.literal('hipaa'),
      adminResponse.literal('pci_dss'),
      adminResponse.literal('sox'),
      adminResponse.literal('iso27001'),
    ] as const),
    requirement: adminResponse.string(),
    description: adminResponse.string(),
    category: adminResponse.string(),
    isMandatory: adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    verificationMethod: adminResponse.string(),
  }),
  status: adminResponse.union([
    adminResponse.literal('compliant'),
    adminResponse.literal('non_compliant'),
    adminResponse.literal('partial'),
    adminResponse.literal('not_applicable'),
  ] as const),
  details: adminResponse.string(),
  evidence: adminResponse.optional(adminResponse.string()),
  remediation: adminResponse.optional(adminResponse.string()),
});

export type ComplianceComplianceCheckResultDtoDto = AdminResponseProjection<
  typeof complianceComplianceCheckResultDtoContract
>;

export const complianceComplianceRequirementDtoContract = adminResponse.object({
  id: adminResponse.string(),
  framework: adminResponse.union([
    adminResponse.literal('gdpr'),
    adminResponse.literal('ccpa'),
    adminResponse.literal('hipaa'),
    adminResponse.literal('pci_dss'),
    adminResponse.literal('sox'),
    adminResponse.literal('iso27001'),
  ] as const),
  requirement: adminResponse.string(),
  description: adminResponse.string(),
  category: adminResponse.string(),
  isMandatory: adminResponse.boolean(),
  verificationMethod: adminResponse.string(),
});

export type ComplianceComplianceRequirementDtoDto = AdminResponseProjection<
  typeof complianceComplianceRequirementDtoContract
>;

export const complianceDataInventoryDtoContract = adminResponse.object({
  category: adminResponse.string(),
  dataTypes: adminResponse.array(adminResponse.string()),
  sources: adminResponse.array(adminResponse.string()),
  purposes: adminResponse.array(adminResponse.string()),
  retentionPeriod: adminResponse.string(),
  legalBasis: adminResponse.string(),
  thirdPartySharing: adminResponse.boolean(),
  crossBorderTransfer: adminResponse.boolean(),
});

export type ComplianceDataInventoryDtoDto = AdminResponseProjection<
  typeof complianceDataInventoryDtoContract
>;

export const securityMonitoringSecurityEventDtoContract = adminResponse.object({
  id: adminResponse.string(),
  eventType: adminResponse.union([
    adminResponse.literal('failed_login'),
    adminResponse.literal('brute_force_attempt'),
    adminResponse.literal('suspicious_activity'),
    adminResponse.literal('unauthorized_access'),
    adminResponse.literal('privilege_escalation'),
    adminResponse.literal('data_exfiltration'),
    adminResponse.literal('malware_detected'),
    adminResponse.literal('api_abuse'),
    adminResponse.literal('rate_limit_exceeded'),
    adminResponse.literal('sql_injection_attempt'),
    adminResponse.literal('xss_attempt'),
    adminResponse.literal('csrf_attempt'),
    adminResponse.literal('account_lockout'),
    adminResponse.literal('password_spray'),
    adminResponse.literal('credential_stuffing'),
    adminResponse.literal('session_hijacking'),
    adminResponse.literal('ip_blacklisted'),
    adminResponse.literal('geo_anomaly'),
    adminResponse.literal('device_anomaly'),
    adminResponse.literal('time_anomaly'),
  ] as const),
  threatLevel: adminResponse.union([
    adminResponse.literal('critical'),
    adminResponse.literal('high'),
    adminResponse.literal('medium'),
    adminResponse.literal('low'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('detected'),
    adminResponse.literal('investigating'),
    adminResponse.literal('confirmed'),
    adminResponse.literal('mitigated'),
    adminResponse.literal('false_positive'),
    adminResponse.literal('escalated'),
  ] as const),
  title: adminResponse.string(),
  description: adminResponse.string(),
  ipAddress: adminResponse.string(),
  geoLocation: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.object({
        country: adminResponse.string(),
        countryCode: adminResponse.string(),
        region: adminResponse.string(),
        city: adminResponse.string(),
        latitude: adminResponse.number(),
        longitude: adminResponse.number(),
        timezone: adminResponse.string(),
      }),
    ),
  ),
  tenantId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  userName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  targetResource: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  targetEndpoint: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  detectionSource: adminResponse.string(),
  confidenceScore: adminResponse.optional(adminResponse.nullable(adminResponse.number())),
  rawData: adminResponse.optional(
    adminResponse.nullable(adminResponse.record(adminResponse.json('security-audit-context'))),
  ),
  assignedTo: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  assignedToName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  investigationNotes: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  resolution: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  resolvedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  resolvedBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type SecurityMonitoringSecurityEventDtoDto = AdminResponseProjection<
  typeof securityMonitoringSecurityEventDtoContract
>;

export const securityMonitoringGetSecurityEventStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  byThreatLevel: adminResponse.record(adminResponse.number()),
  byEventType: adminResponse.record(adminResponse.number()),
  byStatus: adminResponse.record(adminResponse.number()),
});

export type SecurityMonitoringGetSecurityEventStatsResponseDto = AdminResponseProjection<
  typeof securityMonitoringGetSecurityEventStatsResponseContract
>;

export const securityMonitoringSecurityIncidentDtoContract = adminResponse.object({
  id: adminResponse.string(),
  incidentNumber: adminResponse.string(),
  title: adminResponse.string(),
  description: adminResponse.string(),
  severity: adminResponse.union([
    adminResponse.literal('critical'),
    adminResponse.literal('high'),
    adminResponse.literal('medium'),
    adminResponse.literal('low'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('closed'),
    adminResponse.literal('investigating'),
    adminResponse.literal('open'),
    adminResponse.literal('contained'),
    adminResponse.literal('eradicated'),
    adminResponse.literal('recovered'),
  ] as const),
  category: adminResponse.string(),
  attackVector: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  affectedSystems: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  affectedTenants: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  dataBreached: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  affectedUsersCount: adminResponse.number(),
  impactDescription: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  businessImpact: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  detectedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  containedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  eradicatedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  recoveredAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  closedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  leadInvestigator: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  leadInvestigatorName: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  relatedSecurityEvents: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  rootCauseAnalysis: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  remediationSteps: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.array(
        adminResponse.object({
          step: adminResponse.string(),
          completed: adminResponse.union([
            adminResponse.literal(false),
            adminResponse.literal(true),
          ] as const),
          completedAt: adminResponse.optional(adminResponse.dateString()),
        }),
      ),
    ),
  ),
  timeline: adminResponse.optional(
    adminResponse.nullable(
      adminResponse.array(
        adminResponse.object({
          timestamp: adminResponse.string(),
          action: adminResponse.string(),
          actor: adminResponse.string(),
          details: adminResponse.optional(adminResponse.string()),
        }),
      ),
    ),
  ),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type SecurityMonitoringSecurityIncidentDtoDto = AdminResponseProjection<
  typeof securityMonitoringSecurityIncidentDtoContract
>;

export const securityMonitoringGetIncidentStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  byStatus: adminResponse.record(adminResponse.number()),
  bySeverity: adminResponse.record(adminResponse.number()),
});

export type SecurityMonitoringGetIncidentStatsResponseDto = AdminResponseProjection<
  typeof securityMonitoringGetIncidentStatsResponseContract
>;

export const securityMonitoringThreatIntelligenceDtoContract = adminResponse.object({
  id: adminResponse.string(),
  indicatorType: adminResponse.union([
    adminResponse.literal('hash'),
    adminResponse.literal('email'),
    adminResponse.literal('domain'),
    adminResponse.literal('ip'),
    adminResponse.literal('url'),
    adminResponse.literal('user_agent'),
    adminResponse.literal('cidr'),
  ] as const),
  value: adminResponse.string(),
  threatLevel: adminResponse.union([
    adminResponse.literal('critical'),
    adminResponse.literal('high'),
    adminResponse.literal('medium'),
    adminResponse.literal('low'),
  ] as const),
  source: adminResponse.string(),
  description: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  threatTypes: adminResponse.optional(
    adminResponse.nullable(adminResponse.array(adminResponse.string())),
  ),
  tags: adminResponse.optional(adminResponse.nullable(adminResponse.array(adminResponse.string()))),
  confidence: adminResponse.number(),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  validFrom: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  validUntil: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  hitCount: adminResponse.number(),
  lastSeenAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  firstSeenAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type SecurityMonitoringThreatIntelligenceDtoDto = AdminResponseProjection<
  typeof securityMonitoringThreatIntelligenceDtoContract
>;

export const securityMonitoringCheckThreatResponseContract = adminResponse.object({
  isThreat: adminResponse.boolean(),
  threat: adminResponse.nullable(
    adminResponse.object({
      id: adminResponse.string(),
      indicatorType: adminResponse.union([
        adminResponse.literal('hash'),
        adminResponse.literal('email'),
        adminResponse.literal('domain'),
        adminResponse.literal('ip'),
        adminResponse.literal('url'),
        adminResponse.literal('user_agent'),
        adminResponse.literal('cidr'),
      ] as const),
      value: adminResponse.string(),
      threatLevel: adminResponse.union([
        adminResponse.literal('critical'),
        adminResponse.literal('high'),
        adminResponse.literal('medium'),
        adminResponse.literal('low'),
      ] as const),
      source: adminResponse.string(),
      description: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
      threatTypes: adminResponse.optional(
        adminResponse.nullable(adminResponse.array(adminResponse.string())),
      ),
      tags: adminResponse.optional(
        adminResponse.nullable(adminResponse.array(adminResponse.string())),
      ),
      confidence: adminResponse.number(),
      isActive: adminResponse.boolean(),
      validFrom: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
      validUntil: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
      hitCount: adminResponse.number(),
      lastSeenAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
      firstSeenAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
});

export type SecurityMonitoringCheckThreatResponseDto = AdminResponseProjection<
  typeof securityMonitoringCheckThreatResponseContract
>;

export const securityMonitoringGetThreatIntelStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  byIndicatorType: adminResponse.record(adminResponse.number()),
  byThreatLevel: adminResponse.record(adminResponse.number()),
});

export type SecurityMonitoringGetThreatIntelStatsResponseDto = AdminResponseProjection<
  typeof securityMonitoringGetThreatIntelStatsResponseContract
>;

export const securityMonitoringAnalyzeLoginResponseContract = adminResponse.object({
  analyzed: adminResponse.literal(true),
  message: adminResponse.string(),
});

export type SecurityMonitoringAnalyzeLoginResponseDto = AdminResponseProjection<
  typeof securityMonitoringAnalyzeLoginResponseContract
>;

export const securityMonitoringAnomalyDetectionConfigDtoContract = adminResponse.object({
  failedLoginThreshold: adminResponse.number(),
  failedLoginWindowMinutes: adminResponse.number(),
  bruteForceThreshold: adminResponse.number(),
  geoAnomalyEnabled: adminResponse.boolean(),
  apiAbuseThreshold: adminResponse.number(),
  apiAbuseWindowMinutes: adminResponse.number(),
  rateLimitAbuseEnabled: adminResponse.boolean(),
  concurrentSessionLimit: adminResponse.number(),
  sessionHijackingDetection: adminResponse.boolean(),
  offHoursThreshold: adminResponse.number(),
  offHoursStart: adminResponse.number(),
  offHoursEnd: adminResponse.number(),
});

export type SecurityMonitoringAnomalyDetectionConfigDtoDto = AdminResponseProjection<
  typeof securityMonitoringAnomalyDetectionConfigDtoContract
>;

export const securityMonitoringSecurityDashboardStatsDtoContract = adminResponse.object({
  totalSecurityEvents: adminResponse.number(),
  criticalEvents: adminResponse.number(),
  activeIncidents: adminResponse.number(),
  threatsBlocked: adminResponse.number(),
  eventsLast24h: adminResponse.number(),
  eventsLast7d: adminResponse.number(),
  eventsLast30d: adminResponse.number(),
  eventsTrend: adminResponse.union([
    adminResponse.literal('stable'),
    adminResponse.literal('increasing'),
    adminResponse.literal('decreasing'),
  ] as const),
  eventsByType: adminResponse.object({
    failed_login: adminResponse.number(),
    brute_force_attempt: adminResponse.number(),
    suspicious_activity: adminResponse.number(),
    unauthorized_access: adminResponse.number(),
    privilege_escalation: adminResponse.number(),
    data_exfiltration: adminResponse.number(),
    malware_detected: adminResponse.number(),
    api_abuse: adminResponse.number(),
    rate_limit_exceeded: adminResponse.number(),
    sql_injection_attempt: adminResponse.number(),
    xss_attempt: adminResponse.number(),
    csrf_attempt: adminResponse.number(),
    account_lockout: adminResponse.number(),
    password_spray: adminResponse.number(),
    credential_stuffing: adminResponse.number(),
    session_hijacking: adminResponse.number(),
    ip_blacklisted: adminResponse.number(),
    geo_anomaly: adminResponse.number(),
    device_anomaly: adminResponse.number(),
    time_anomaly: adminResponse.number(),
  }),
  eventsBySeverity: adminResponse.object({
    critical: adminResponse.number(),
    low: adminResponse.number(),
    medium: adminResponse.number(),
    high: adminResponse.number(),
  }),
  topSourceIPs: adminResponse.array(
    adminResponse.object({
      ip: adminResponse.string(),
      count: adminResponse.number(),
      threatLevel: adminResponse.union([
        adminResponse.literal('critical'),
        adminResponse.literal('high'),
        adminResponse.literal('medium'),
        adminResponse.literal('low'),
      ] as const),
    }),
  ),
  topTargetedUsers: adminResponse.array(
    adminResponse.object({
      userId: adminResponse.string(),
      userName: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  topEventTypes: adminResponse.array(
    adminResponse.object({
      type: adminResponse.union([
        adminResponse.literal('failed_login'),
        adminResponse.literal('brute_force_attempt'),
        adminResponse.literal('suspicious_activity'),
        adminResponse.literal('unauthorized_access'),
        adminResponse.literal('privilege_escalation'),
        adminResponse.literal('data_exfiltration'),
        adminResponse.literal('malware_detected'),
        adminResponse.literal('api_abuse'),
        adminResponse.literal('rate_limit_exceeded'),
        adminResponse.literal('sql_injection_attempt'),
        adminResponse.literal('xss_attempt'),
        adminResponse.literal('csrf_attempt'),
        adminResponse.literal('account_lockout'),
        adminResponse.literal('password_spray'),
        adminResponse.literal('credential_stuffing'),
        adminResponse.literal('session_hijacking'),
        adminResponse.literal('ip_blacklisted'),
        adminResponse.literal('geo_anomaly'),
        adminResponse.literal('device_anomaly'),
        adminResponse.literal('time_anomaly'),
      ] as const),
      count: adminResponse.number(),
    }),
  ),
  eventsTimeline: adminResponse.array(
    adminResponse.object({
      date: adminResponse.string(),
      critical: adminResponse.number(),
      high: adminResponse.number(),
      medium: adminResponse.number(),
      low: adminResponse.number(),
    }),
  ),
});

export type SecurityMonitoringSecurityDashboardStatsDtoDto = AdminResponseProjection<
  typeof securityMonitoringSecurityDashboardStatsDtoContract
>;

export const securityMonitoringSecurityHealthScoreDtoContract = adminResponse.object({
  score: adminResponse.number(),
  factors: adminResponse.array(
    adminResponse.object({
      name: adminResponse.string(),
      score: adminResponse.number(),
      weight: adminResponse.number(),
      description: adminResponse.string(),
    }),
  ),
  recommendations: adminResponse.array(adminResponse.string()),
});

export type SecurityMonitoringSecurityHealthScoreDtoDto = AdminResponseProjection<
  typeof securityMonitoringSecurityHealthScoreDtoContract
>;

export const activityLogActivityLogDtoPageContract = adminResponse.page(
  activityLogActivityLogDtoContract,
);

export const activityLogActivityLogDtoArrayContract = adminResponse.array(
  activityLogActivityLogDtoContract,
);

export const activityLogLoginAttemptDtoArrayContract = adminResponse.array(
  activityLogLoginAttemptDtoContract,
);

export const activityLogUserSessionDtoArrayContract = adminResponse.array(
  activityLogUserSessionDtoContract,
);

export const auditTrailAuditAlertRuleDtoArrayContract = adminResponse.array(
  auditTrailAuditAlertRuleDtoContract,
);

export const auditTrailRetentionPolicyDtoArrayContract = adminResponse.array(
  auditTrailRetentionPolicyDtoContract,
);

export const complianceComplianceCheckResultDtoArrayContract = adminResponse.array(
  complianceComplianceCheckResultDtoContract,
);

export const complianceComplianceReportDtoPageContract = adminResponse.page(
  complianceComplianceReportDtoContract,
);

export const complianceComplianceRequirementDtoArrayContract = adminResponse.array(
  complianceComplianceRequirementDtoContract,
);

export const complianceDataInventoryDtoArrayContract = adminResponse.array(
  complianceDataInventoryDtoContract,
);

export const complianceDataRequestDtoArrayContract = adminResponse.array(
  complianceDataRequestDtoContract,
);

export const complianceDataRequestDtoPageContract = adminResponse.page(
  complianceDataRequestDtoContract,
);

export const securityMonitoringSecurityEventDtoArrayContract = adminResponse.array(
  securityMonitoringSecurityEventDtoContract,
);

export const securityMonitoringSecurityEventDtoPageContract = adminResponse.page(
  securityMonitoringSecurityEventDtoContract,
);

export const securityMonitoringSecurityIncidentDtoPageContract = adminResponse.page(
  securityMonitoringSecurityIncidentDtoContract,
);

export const securityMonitoringThreatIntelligenceDtoPageContract = adminResponse.page(
  securityMonitoringThreatIntelligenceDtoContract,
);
