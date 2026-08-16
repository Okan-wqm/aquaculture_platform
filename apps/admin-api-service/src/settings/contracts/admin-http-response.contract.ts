import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const emailTemplateEmailTemplateResponseContract = adminResponse.object({
  id: adminResponse.string(),
  code: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  category: adminResponse.string(),
  subject: adminResponse.string(),
  bodyHtml: adminResponse.string(),
  bodyText: adminResponse.optional(adminResponse.string()),
  variables: adminResponse.array(
    adminResponse.object({
      name: adminResponse.string(),
      description: adminResponse.string(),
      required: adminResponse.boolean(),
      defaultValue: adminResponse.optional(adminResponse.string()),
    }),
  ),
  isActive: adminResponse.boolean(),
  isSystem: adminResponse.boolean(),
  tenantId: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type EmailTemplateEmailTemplateResponseDto = AdminResponseProjection<
  typeof emailTemplateEmailTemplateResponseContract
>;

export const emailTemplateGetTemplateCategoriesResponseContract = adminResponse.string();

export type EmailTemplateGetTemplateCategoriesResponseDto = AdminResponseProjection<
  typeof emailTemplateGetTemplateCategoriesResponseContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const emailTemplateRenderTemplateResponseContract = adminResponse.object({
  subject: adminResponse.string(),
  bodyHtml: adminResponse.string(),
  bodyText: adminResponse.string(),
});

export type EmailTemplateRenderTemplateResponseDto = AdminResponseProjection<
  typeof emailTemplateRenderTemplateResponseContract
>;

export const emailTemplatePreviewTemplateResponseContract = adminResponse.object({
  subject: adminResponse.string(),
  bodyHtml: adminResponse.string(),
  bodyText: adminResponse.string(),
});

export type EmailTemplatePreviewTemplateResponseDto = AdminResponseProjection<
  typeof emailTemplatePreviewTemplateResponseContract
>;

export const emailTemplateValidateTemplateResponseContract = adminResponse.object({
  valid: adminResponse.boolean(),
  errors: adminResponse.array(adminResponse.string()),
  warnings: adminResponse.array(adminResponse.string()),
});

export type EmailTemplateValidateTemplateResponseDto = AdminResponseProjection<
  typeof emailTemplateValidateTemplateResponseContract
>;

export const emailTemplateSendTestEmailResponseContract = adminResponse.object({
  message: adminResponse.string(),
  recipientEmail: adminResponse.string(),
  rendered: adminResponse.object({
    subject: adminResponse.string(),
    bodyHtml: adminResponse.string(),
    bodyText: adminResponse.string(),
  }),
});

export type EmailTemplateSendTestEmailResponseDto = AdminResponseProjection<
  typeof emailTemplateSendTestEmailResponseContract
>;

export const ipAccessIpAccessRuleContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.optional(adminResponse.string()),
  ruleType: adminResponse.union([
    adminResponse.literal('whitelist'),
    adminResponse.literal('blacklist'),
  ] as const),
  ipAddress: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  hitCount: adminResponse.number(),
  lastHitAt: adminResponse.optional(adminResponse.dateString()),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
});

export type IpAccessIpAccessRuleDto = AdminResponseProjection<typeof ipAccessIpAccessRuleContract>;

export const ipAccessIpAccessRuleResponseContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.optional(adminResponse.string()),
  ipAddress: adminResponse.string(),
  ruleType: adminResponse.union([
    adminResponse.literal('whitelist'),
    adminResponse.literal('blacklist'),
  ] as const),
  description: adminResponse.optional(adminResponse.string()),
  isActive: adminResponse.boolean(),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  hitCount: adminResponse.number(),
  lastHitAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
  createdBy: adminResponse.optional(adminResponse.string()),
});

export type IpAccessIpAccessRuleResponseDto = AdminResponseProjection<
  typeof ipAccessIpAccessRuleResponseContract
>;

export const ipAccessCheckIpAccessResponseContract = adminResponse.object({
  allowed: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  matchedRule: adminResponse.optional(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.optional(adminResponse.string()),
      ruleType: adminResponse.union([
        adminResponse.literal('whitelist'),
        adminResponse.literal('blacklist'),
      ] as const),
      ipAddress: adminResponse.string(),
      description: adminResponse.optional(adminResponse.string()),
      isActive: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      hitCount: adminResponse.number(),
      lastHitAt: adminResponse.optional(adminResponse.dateString()),
      createdBy: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
    }),
  ),
});

export type IpAccessCheckIpAccessResponseDto = AdminResponseProjection<
  typeof ipAccessCheckIpAccessResponseContract
>;

export const ipAccessBulkWhitelistResponseContract = adminResponse.object({
  added: adminResponse.number(),
  skipped: adminResponse.number(),
  errors: adminResponse.array(adminResponse.string()),
});

export type IpAccessBulkWhitelistResponseDto = AdminResponseProjection<
  typeof ipAccessBulkWhitelistResponseContract
>;

export const ipAccessBulkBlacklistResponseContract = adminResponse.object({
  added: adminResponse.number(),
  skipped: adminResponse.number(),
  errors: adminResponse.array(adminResponse.string()),
});

export type IpAccessBulkBlacklistResponseDto = AdminResponseProjection<
  typeof ipAccessBulkBlacklistResponseContract
>;

export const ipAccessClearRulesResponseContract = adminResponse.object({
  deleted: adminResponse.number(),
});

export type IpAccessClearRulesResponseDto = AdminResponseProjection<
  typeof ipAccessClearRulesResponseContract
>;

export const ipAccessGetStatisticsResponseContract = adminResponse.object({
  totalRules: adminResponse.number(),
  whitelistCount: adminResponse.number(),
  blacklistCount: adminResponse.number(),
  activeRules: adminResponse.number(),
  expiredRules: adminResponse.number(),
  totalHits: adminResponse.number(),
  mostHitRules: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.optional(adminResponse.string()),
      ipAddress: adminResponse.string(),
      ruleType: adminResponse.union([
        adminResponse.literal('whitelist'),
        adminResponse.literal('blacklist'),
      ] as const),
      description: adminResponse.optional(adminResponse.string()),
      isActive: adminResponse.boolean(),
      expiresAt: adminResponse.optional(adminResponse.dateString()),
      hitCount: adminResponse.number(),
      lastHitAt: adminResponse.optional(adminResponse.dateString()),
      createdAt: adminResponse.dateString(),
      createdBy: adminResponse.optional(adminResponse.string()),
    }),
  ),
});

export type IpAccessGetStatisticsResponseDto = AdminResponseProjection<
  typeof ipAccessGetStatisticsResponseContract
>;

export const ipAccessCleanupExpiredRulesResponseContract = adminResponse.object({
  deleted: adminResponse.number(),
});

export type IpAccessCleanupExpiredRulesResponseDto = AdminResponseProjection<
  typeof ipAccessCleanupExpiredRulesResponseContract
>;

export const neverResponseContract = adminResponse.never();

export type NeverResponseDto = AdminResponseProjection<typeof neverResponseContract>;

export const settingsSettingsByCategoryContract = adminResponse.record(
  adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      key: adminResponse.string(),
      value: adminResponse.json('operator-configuration'),
      valueType: adminResponse.union([
        adminResponse.literal('string'),
        adminResponse.literal('number'),
        adminResponse.literal('boolean'),
        adminResponse.literal('json'),
        adminResponse.literal('encrypted'),
      ] as const),
      category: adminResponse.union([
        adminResponse.literal('general'),
        adminResponse.literal('security'),
        adminResponse.literal('email'),
        adminResponse.literal('sms'),
        adminResponse.literal('billing'),
        adminResponse.literal('rate_limit'),
        adminResponse.literal('storage'),
        adminResponse.literal('integration'),
        adminResponse.literal('notification'),
        adminResponse.literal('feature_flag'),
        adminResponse.literal('maintenance'),
      ] as const),
      description: adminResponse.optional(adminResponse.string()),
      displayName: adminResponse.optional(adminResponse.string()),
      isPublic: adminResponse.boolean(),
      isReadOnly: adminResponse.boolean(),
      requiresRestart: adminResponse.boolean(),
      defaultValue: adminResponse.optional(adminResponse.json('operator-configuration')),
      updatedAt: adminResponse.dateString(),
    }),
  ),
);

export type SettingsSettingsByCategoryDto = AdminResponseProjection<
  typeof settingsSettingsByCategoryContract
>;

export const settingsSystemSettingResponseContract = adminResponse.object({
  id: adminResponse.string(),
  key: adminResponse.string(),
  value: adminResponse.json('operator-configuration'),
  valueType: adminResponse.union([
    adminResponse.literal('string'),
    adminResponse.literal('number'),
    adminResponse.literal('boolean'),
    adminResponse.literal('json'),
    adminResponse.literal('encrypted'),
  ] as const),
  category: adminResponse.union([
    adminResponse.literal('general'),
    adminResponse.literal('security'),
    adminResponse.literal('email'),
    adminResponse.literal('sms'),
    adminResponse.literal('billing'),
    adminResponse.literal('rate_limit'),
    adminResponse.literal('storage'),
    adminResponse.literal('integration'),
    adminResponse.literal('notification'),
    adminResponse.literal('feature_flag'),
    adminResponse.literal('maintenance'),
  ] as const),
  description: adminResponse.optional(adminResponse.string()),
  displayName: adminResponse.optional(adminResponse.string()),
  isPublic: adminResponse.boolean(),
  isReadOnly: adminResponse.boolean(),
  requiresRestart: adminResponse.boolean(),
  defaultValue: adminResponse.optional(adminResponse.json('operator-configuration')),
  updatedAt: adminResponse.dateString(),
});

export type SettingsSystemSettingResponseDto = AdminResponseProjection<
  typeof settingsSystemSettingResponseContract
>;

export const settingsEmailConfigContract = adminResponse.object({
  smtpHost: adminResponse.string(),
  smtpPort: adminResponse.number(),
  smtpSecure: adminResponse.boolean(),
  smtpUsername: adminResponse.string(),
  hasSmtpPassword: adminResponse.boolean(),
  fromAddress: adminResponse.string(),
  fromName: adminResponse.string(),
});

export type SettingsEmailConfigDto = AdminResponseProjection<typeof settingsEmailConfigContract>;

export const settingsTestEmailConfigResponseContract = adminResponse.union([
  adminResponse.object({
    success: adminResponse.boolean(),
    messageId: adminResponse.optional(adminResponse.string()),
    error: adminResponse.optional(adminResponse.string()),
    attempts: adminResponse.optional(adminResponse.number()),
    circuitBreakerOpen: adminResponse.optional(
      adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
    ),
  }),
  adminResponse.object({
    success: adminResponse.boolean(),
    messageId: adminResponse.optional(adminResponse.string()),
    attempts: adminResponse.optional(adminResponse.number()),
    error: adminResponse.optional(adminResponse.string()),
  }),
] as const);

export type SettingsTestEmailConfigResponseDto = AdminResponseProjection<
  typeof settingsTestEmailConfigResponseContract
>;

export const settingsGetSecurityConfigResponseContract = adminResponse.object({
  sessionTimeoutMinutes: adminResponse.number(),
  maxLoginAttempts: adminResponse.number(),
  lockoutDurationMinutes: adminResponse.number(),
  passwordMinLength: adminResponse.number(),
  passwordRequireUppercase: adminResponse.boolean(),
  passwordRequireNumbers: adminResponse.boolean(),
  passwordRequireSymbols: adminResponse.boolean(),
  mfaEnabled: adminResponse.boolean(),
  enforceHttps: adminResponse.boolean(),
});

export type SettingsGetSecurityConfigResponseDto = AdminResponseProjection<
  typeof settingsGetSecurityConfigResponseContract
>;

export const settingsGetRateLimitConfigResponseContract = adminResponse.object({
  globalRpm: adminResponse.number(),
  perUserRpm: adminResponse.number(),
  perTenantRpm: adminResponse.number(),
  apiKeyRpm: adminResponse.number(),
});

export type SettingsGetRateLimitConfigResponseDto = AdminResponseProjection<
  typeof settingsGetRateLimitConfigResponseContract
>;

export const settingsGetMaintenanceStatusResponseContract = adminResponse.object({
  enabled: adminResponse.boolean(),
  message: adminResponse.string(),
  allowedIps: adminResponse.array(adminResponse.string()),
});

export type SettingsGetMaintenanceStatusResponseDto = AdminResponseProjection<
  typeof settingsGetMaintenanceStatusResponseContract
>;

export const settingsGetBillingConfigResponseContract = adminResponse.object({
  currency: adminResponse.string(),
  taxRate: adminResponse.number(),
  invoiceDueDays: adminResponse.number(),
  gracePeriodDays: adminResponse.number(),
});

export type SettingsGetBillingConfigResponseDto = AdminResponseProjection<
  typeof settingsGetBillingConfigResponseContract
>;

export const settingsIsFeatureEnabledResponseContract = adminResponse.object({
  featureKey: adminResponse.string(),
  enabled: adminResponse.boolean(),
});

export type SettingsIsFeatureEnabledResponseDto = AdminResponseProjection<
  typeof settingsIsFeatureEnabledResponseContract
>;

export const settingsExportSettingsResponseContract = adminResponse.record(
  adminResponse.json('operator-configuration'),
);

export type SettingsExportSettingsResponseDto = AdminResponseProjection<
  typeof settingsExportSettingsResponseContract
>;

export const settingsGetSystemInfoResponseContract = adminResponse.object({
  platform: adminResponse.object({
    name: adminResponse.string(),
    version: adminResponse.string(),
  }),
  security: adminResponse.object({
    sessionTimeoutMinutes: adminResponse.number(),
    maxLoginAttempts: adminResponse.number(),
    lockoutDurationMinutes: adminResponse.number(),
    passwordMinLength: adminResponse.number(),
    passwordRequireUppercase: adminResponse.boolean(),
    passwordRequireNumbers: adminResponse.boolean(),
    passwordRequireSymbols: adminResponse.boolean(),
    mfaEnabled: adminResponse.boolean(),
    enforceHttps: adminResponse.boolean(),
  }),
  rateLimits: adminResponse.object({
    globalRpm: adminResponse.number(),
    perUserRpm: adminResponse.number(),
    perTenantRpm: adminResponse.number(),
    apiKeyRpm: adminResponse.number(),
  }),
  maintenance: adminResponse.object({
    enabled: adminResponse.boolean(),
    message: adminResponse.string(),
    allowedIps: adminResponse.array(adminResponse.string()),
  }),
});

export type SettingsGetSystemInfoResponseDto = AdminResponseProjection<
  typeof settingsGetSystemInfoResponseContract
>;

export const emailTemplateEmailTemplateResponseArrayContract = adminResponse.array(
  emailTemplateEmailTemplateResponseContract,
);

export const emailTemplateGetTemplateCategoriesResponseArrayContract = adminResponse.array(
  emailTemplateGetTemplateCategoriesResponseContract,
);

export const ipAccessIpAccessRulePageContract = adminResponse.page(ipAccessIpAccessRuleContract);

export const ipAccessIpAccessRuleResponseArrayContract = adminResponse.array(
  ipAccessIpAccessRuleResponseContract,
);

export const settingsSystemSettingResponseArrayContract = adminResponse.array(
  settingsSystemSettingResponseContract,
);
