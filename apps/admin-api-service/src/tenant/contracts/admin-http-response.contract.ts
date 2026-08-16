import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const tenantPublicCreateTenantAcceptedResponseContract = adminResponse.object({
  status: adminResponse.union([
    adminResponse.literal('QUEUED'),
    adminResponse.literal('RESERVING'),
    adminResponse.literal('RUNNING'),
    adminResponse.literal('WAITING_ONBOARDING'),
    adminResponse.literal('SUCCEEDED'),
    adminResponse.literal('FAILED'),
  ] as const),
  tenantStatus: adminResponse.optional(
    adminResponse.union([
      adminResponse.literal('PENDING'),
      adminResponse.literal('PROVISIONING'),
      adminResponse.literal('PROVISIONING_FAILED'),
      adminResponse.literal('ACTIVE'),
      adminResponse.literal('SUSPENDED'),
      adminResponse.literal('DEACTIVATED'),
      adminResponse.literal('CANCELLED'),
      adminResponse.literal('ARCHIVED'),
      adminResponse.literal('PURGED'),
    ] as const),
  ),
  statusUrl: adminResponse.string(),
  retryAfterMs: adminResponse.number(),
  availableActions: adminResponse.array(adminResponse.string()),
});

export type TenantPublicCreateTenantAcceptedResponseDto = AdminResponseProjection<
  typeof tenantPublicCreateTenantAcceptedResponseContract
>;

export const tenantAdminTenantListItemDtoContract = adminResponse.object({
  userCount: adminResponse.number(),
  farmCount: adminResponse.number(),
  sensorCount: adminResponse.number(),
  id: adminResponse.string(),
  name: adminResponse.string(),
  slug: adminResponse.string(),
  domain: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('PENDING'),
    adminResponse.literal('PROVISIONING'),
    adminResponse.literal('PROVISIONING_FAILED'),
    adminResponse.literal('ACTIVE'),
    adminResponse.literal('SUSPENDED'),
    adminResponse.literal('DEACTIVATED'),
    adminResponse.literal('CANCELLED'),
    adminResponse.literal('ARCHIVED'),
    adminResponse.literal('PURGED'),
  ] as const),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('trial'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
  ] as const),
  contactEmail: adminResponse.optional(adminResponse.string()),
  description: adminResponse.optional(adminResponse.string()),
  trialEndsAt: adminResponse.nullable(adminResponse.dateString()),
  isTrialActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type TenantAdminTenantListItemDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantListItemDtoContract
>;

export const tenantAdminTenantStatsDtoContract = adminResponse.object({
  totalTenants: adminResponse.number(),
  activeTenants: adminResponse.number(),
  suspendedTenants: adminResponse.number(),
  pendingTenants: adminResponse.number(),
  byTier: adminResponse.optional(adminResponse.record(adminResponse.number())),
  byPlan: adminResponse.optional(adminResponse.record(adminResponse.number())),
  newTenantsLast30Days: adminResponse.number(),
  churnedTenantsLast30Days: adminResponse.number(),
});

export type TenantAdminTenantStatsDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantStatsDtoContract
>;

export const tenantAdminTenantSummaryDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  slug: adminResponse.string(),
  domain: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('PENDING'),
    adminResponse.literal('PROVISIONING'),
    adminResponse.literal('PROVISIONING_FAILED'),
    adminResponse.literal('ACTIVE'),
    adminResponse.literal('SUSPENDED'),
    adminResponse.literal('DEACTIVATED'),
    adminResponse.literal('CANCELLED'),
    adminResponse.literal('ARCHIVED'),
    adminResponse.literal('PURGED'),
  ] as const),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('trial'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
  ] as const),
  contactEmail: adminResponse.optional(adminResponse.string()),
  description: adminResponse.optional(adminResponse.string()),
  trialEndsAt: adminResponse.nullable(adminResponse.dateString()),
  isTrialActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type TenantAdminTenantSummaryDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantSummaryDtoContract
>;

export const tenantAdminTenantPublicSummaryDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  slug: adminResponse.string(),
  domain: adminResponse.optional(adminResponse.string()),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('trial'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
  ] as const),
  contactEmail: adminResponse.optional(adminResponse.string()),
  description: adminResponse.optional(adminResponse.string()),
  trialEndsAt: adminResponse.nullable(adminResponse.dateString()),
  isTrialActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type TenantAdminTenantPublicSummaryDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantPublicSummaryDtoContract
>;

export const tenantAdminBulkTenantOperationResultContract = adminResponse.object({
  success: adminResponse.array(adminResponse.string()),
  failed: adminResponse.array(adminResponse.string()),
});

export type TenantAdminBulkTenantOperationResultDto = AdminResponseProjection<
  typeof tenantAdminBulkTenantOperationResultContract
>;

export const tenantAdminTenantDetailDtoContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  slug: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  domain: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('PENDING'),
    adminResponse.literal('PROVISIONING'),
    adminResponse.literal('PROVISIONING_FAILED'),
    adminResponse.literal('ACTIVE'),
    adminResponse.literal('SUSPENDED'),
    adminResponse.literal('DEACTIVATED'),
    adminResponse.literal('CANCELLED'),
    adminResponse.literal('ARCHIVED'),
    adminResponse.literal('PURGED'),
  ] as const),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('trial'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
  ] as const),
  trialEndsAt: adminResponse.optional(adminResponse.dateString()),
  suspendedAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  suspendedReason: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  availableActions: adminResponse.array(
    adminResponse.union([
      adminResponse.literal('activate'),
      adminResponse.literal('suspend'),
      adminResponse.literal('deactivate'),
      adminResponse.literal('archive'),
      adminResponse.literal('retryProvisioning'),
    ] as const),
  ),
  primaryContact: adminResponse.optional(
    adminResponse.object({
      name: adminResponse.string(),
      email: adminResponse.string(),
      phone: adminResponse.optional(adminResponse.string()),
      role: adminResponse.string(),
    }),
  ),
  billingContact: adminResponse.optional(
    adminResponse.object({
      name: adminResponse.string(),
      email: adminResponse.string(),
      phone: adminResponse.optional(adminResponse.string()),
      role: adminResponse.string(),
    }),
  ),
  billingEmail: adminResponse.optional(adminResponse.string()),
  country: adminResponse.optional(adminResponse.string()),
  region: adminResponse.optional(adminResponse.string()),
  settings: adminResponse.optional(
    adminResponse.object({
      timezone: adminResponse.string(),
      locale: adminResponse.string(),
      currency: adminResponse.string(),
      dateFormat: adminResponse.string(),
      measurementSystem: adminResponse.string(),
      notificationPreferences: adminResponse.object({
        email: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
        sms: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
        push: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
        slack: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
      }),
      features: adminResponse.array(adminResponse.string()),
    }),
  ),
  limits: adminResponse.optional(
    adminResponse.object({
      maxUsers: adminResponse.optional(adminResponse.number()),
      maxFarms: adminResponse.optional(adminResponse.number()),
      maxPonds: adminResponse.optional(adminResponse.number()),
      maxSensors: adminResponse.optional(adminResponse.number()),
      maxAlertRules: adminResponse.optional(adminResponse.number()),
      dataRetentionDays: adminResponse.optional(adminResponse.number()),
      apiRateLimit: adminResponse.optional(adminResponse.number()),
      storageGb: adminResponse.optional(adminResponse.number()),
    }),
  ),
  userCount: adminResponse.number(),
  farmCount: adminResponse.number(),
  sensorCount: adminResponse.number(),
  maxStorage: adminResponse.number(),
  isTrialActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  userStats: adminResponse.optional(
    adminResponse.object({
      total: adminResponse.number(),
      active: adminResponse.number(),
      inactive: adminResponse.number(),
      byRole: adminResponse.object({
        admin: adminResponse.number(),
        manager: adminResponse.number(),
        supervisor: adminResponse.number(),
        operator: adminResponse.number(),
        viewer: adminResponse.number(),
      }),
      recentlyActive: adminResponse.number(),
      newUsersLast30Days: adminResponse.number(),
    }),
  ),
  resourceUsage: adminResponse.optional(
    adminResponse.object({
      storage: adminResponse.object({
        usedGb: adminResponse.number(),
        limitGb: adminResponse.number(),
        percentage: adminResponse.number(),
      }),
      users: adminResponse.object({
        count: adminResponse.number(),
        limit: adminResponse.number(),
        percentage: adminResponse.number(),
      }),
      farms: adminResponse.object({
        count: adminResponse.number(),
        limit: adminResponse.number(),
        percentage: adminResponse.number(),
      }),
      sensors: adminResponse.object({
        count: adminResponse.number(),
        limit: adminResponse.number(),
        percentage: adminResponse.number(),
      }),
      apiCalls: adminResponse.object({
        last24h: adminResponse.number(),
        last7d: adminResponse.number(),
        limit: adminResponse.number(),
      }),
    }),
  ),
  modules: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        moduleId: adminResponse.string(),
        moduleCode: adminResponse.string(),
        moduleName: adminResponse.string(),
        isActive: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
        assignedAt: adminResponse.dateString(),
        usageCount: adminResponse.optional(adminResponse.number()),
        lastUsedAt: adminResponse.optional(adminResponse.dateString()),
      }),
    ),
  ),
  recentActivities: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        id: adminResponse.string(),
        tenantId: adminResponse.string(),
        activityType: adminResponse.union([
          adminResponse.literal('created'),
          adminResponse.literal('activated'),
          adminResponse.literal('suspended'),
          adminResponse.literal('deactivated'),
          adminResponse.literal('plan_changed'),
          adminResponse.literal('limits_updated'),
          adminResponse.literal('module_assigned'),
          adminResponse.literal('module_removed'),
          adminResponse.literal('user_added'),
          adminResponse.literal('user_removed'),
          adminResponse.literal('settings_updated'),
          adminResponse.literal('payment_received'),
          adminResponse.literal('payment_failed'),
          adminResponse.literal('trial_started'),
          adminResponse.literal('trial_expired'),
          adminResponse.literal('contact_updated'),
          adminResponse.literal('domain_changed'),
        ] as const),
        title: adminResponse.string(),
        description: adminResponse.optional(adminResponse.string()),
        metadata: adminResponse.optional(
          adminResponse.record(adminResponse.json('extension-metadata')),
        ),
        previousValue: adminResponse.optional(
          adminResponse.record(adminResponse.json('security-audit-context')),
        ),
        newValue: adminResponse.optional(
          adminResponse.record(adminResponse.json('security-audit-context')),
        ),
        performedBy: adminResponse.optional(adminResponse.string()),
        performedByEmail: adminResponse.optional(adminResponse.string()),
        createdAt: adminResponse.dateString(),
      }),
    ),
  ),
  notes: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        id: adminResponse.string(),
        tenantId: adminResponse.string(),
        content: adminResponse.string(),
        category: adminResponse.string(),
        isPinned: adminResponse.union([
          adminResponse.literal(false),
          adminResponse.literal(true),
        ] as const),
        createdBy: adminResponse.string(),
        createdByEmail: adminResponse.optional(adminResponse.string()),
        createdAt: adminResponse.dateString(),
        updatedAt: adminResponse.dateString(),
      }),
    ),
  ),
  billing: adminResponse.optional(
    adminResponse.object({
      currentPlan: adminResponse.string(),
      monthlyAmount: adminResponse.number(),
      currency: adminResponse.string(),
      billingCycle: adminResponse.string(),
      paymentStatus: adminResponse.string(),
      nextBillingDate: adminResponse.nullable(adminResponse.dateString()),
      lastPaymentDate: adminResponse.nullable(adminResponse.dateString()),
      lastPaymentAmount: adminResponse.nullable(adminResponse.number()),
    }),
  ),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
  createdBy: adminResponse.optional(adminResponse.string()),
});

export type TenantAdminTenantDetailDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantDetailDtoContract
>;

export const tenantAdminTenantUsageDtoContract = adminResponse.object({
  tenantId: adminResponse.string(),
  userCount: adminResponse.optional(adminResponse.number()),
  farmCount: adminResponse.optional(adminResponse.number()),
  sensorCount: adminResponse.optional(adminResponse.number()),
  alertRuleCount: adminResponse.optional(adminResponse.number()),
  storageUsedGb: adminResponse.optional(adminResponse.number()),
  apiCallsLast24h: adminResponse.optional(adminResponse.number()),
  maxUsers: adminResponse.optional(adminResponse.number()),
  currentUserCount: adminResponse.optional(adminResponse.number()),
  limits: adminResponse.optional(
    adminResponse.object({
      maxUsers: adminResponse.optional(adminResponse.number()),
      maxFarms: adminResponse.optional(adminResponse.number()),
      maxPonds: adminResponse.optional(adminResponse.number()),
      maxSensors: adminResponse.optional(adminResponse.number()),
      maxAlertRules: adminResponse.optional(adminResponse.number()),
      dataRetentionDays: adminResponse.optional(adminResponse.number()),
      apiRateLimit: adminResponse.optional(adminResponse.number()),
      storageGb: adminResponse.optional(adminResponse.number()),
    }),
  ),
  usagePercentage: adminResponse.optional(
    adminResponse.union([
      adminResponse.number(),
      adminResponse.object({
        users: adminResponse.number(),
        farms: adminResponse.optional(adminResponse.number()),
        sensors: adminResponse.optional(adminResponse.number()),
        alertRules: adminResponse.optional(adminResponse.number()),
        storage: adminResponse.optional(adminResponse.number()),
      }),
    ] as const),
  ),
});

export type TenantAdminTenantUsageDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantUsageDtoContract
>;

export const tenantAdminTenantActivityDtoContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  activityType: adminResponse.union([
    adminResponse.literal('created'),
    adminResponse.literal('activated'),
    adminResponse.literal('suspended'),
    adminResponse.literal('deactivated'),
    adminResponse.literal('plan_changed'),
    adminResponse.literal('limits_updated'),
    adminResponse.literal('module_assigned'),
    adminResponse.literal('module_removed'),
    adminResponse.literal('user_added'),
    adminResponse.literal('user_removed'),
    adminResponse.literal('settings_updated'),
    adminResponse.literal('payment_received'),
    adminResponse.literal('payment_failed'),
    adminResponse.literal('trial_started'),
    adminResponse.literal('trial_expired'),
    adminResponse.literal('contact_updated'),
    adminResponse.literal('domain_changed'),
  ] as const),
  title: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  previousValue: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
  newValue: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
  performedBy: adminResponse.optional(adminResponse.string()),
  performedByEmail: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
});

export type TenantAdminTenantActivityDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantActivityDtoContract
>;

export const tenantAdminTenantNoteDtoContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  content: adminResponse.string(),
  category: adminResponse.string(),
  isPinned: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  createdBy: adminResponse.string(),
  createdByEmail: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type TenantAdminTenantNoteDtoDto = AdminResponseProjection<
  typeof tenantAdminTenantNoteDtoContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const tenantAdminTenantErasureOperationAcceptedResponseContract = adminResponse.object({
  operationId: adminResponse.string(),
  tenantId: adminResponse.string(),
  status: adminResponse.literal('IN_PROGRESS'),
});

export type TenantAdminTenantErasureOperationAcceptedResponseDto = AdminResponseProjection<
  typeof tenantAdminTenantErasureOperationAcceptedResponseContract
>;

export const tenantAdminReconcileTenantSubscriptionResponseContract = adminResponse.object({
  tenantId: adminResponse.string(),
  subscriptionId: adminResponse.optional(adminResponse.string()),
  status: adminResponse.optional(adminResponse.string()),
  moduleItemCount: adminResponse.optional(adminResponse.number()),
  replayed: adminResponse.optional(
    adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
  ),
});

export type TenantAdminReconcileTenantSubscriptionResponseDto = AdminResponseProjection<
  typeof tenantAdminReconcileTenantSubscriptionResponseContract
>;

export const tenantAdminTenantActivityDtoPageContract = adminResponse.page(
  tenantAdminTenantActivityDtoContract,
);

export const tenantAdminTenantListItemDtoPageContract = adminResponse.page(
  tenantAdminTenantListItemDtoContract,
);

export const tenantAdminTenantNoteDtoArrayContract = adminResponse.array(
  tenantAdminTenantNoteDtoContract,
);

export const tenantAdminTenantSummaryDtoArrayContract = adminResponse.array(
  tenantAdminTenantSummaryDtoContract,
);
