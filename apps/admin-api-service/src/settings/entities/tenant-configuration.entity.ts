import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Tenant-level configuration entity
 * Stores all tenant-specific settings with JSON structure
 */
@Entity('tenant_configurations')
@Index(['tenantId'], { unique: true })
export class TenantConfiguration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  tenantId!: string;

  // ============================================================================
  // User & Access Limits
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  userLimits!: UserLimitsConfig;

  // ============================================================================
  // Storage Configuration
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  storageConfig!: StorageConfig;

  // ============================================================================
  // API Configuration
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  apiConfig!: ApiConfig;

  // ============================================================================
  // Data Retention Settings
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  dataRetention!: DataRetentionConfig;

  // ============================================================================
  // Domain & Branding
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  domainConfig!: DomainConfig;

  @Column('jsonb', { default: '{}' })
  brandingConfig!: BrandingConfig;

  // ============================================================================
  // Security Settings
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  securityConfig!: TenantSecurityConfig;

  // ============================================================================
  // Notification Settings
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  notificationConfig!: TenantNotificationConfig;

  // ============================================================================
  // Feature Flags
  // ============================================================================

  @Column('jsonb', { default: '{}' })
  featureFlags!: FeatureFlagsConfig;

  // ============================================================================
  // Metadata
  // ============================================================================

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  updatedBy?: string;
}

// ============================================================================
// Configuration Interfaces
// ============================================================================

export interface UserLimitsConfig {
  maxUsers: number;
  maxAdmins: number;
  maxModuleManagers: number;
  maxConcurrentSessions: number;
  sessionTimeoutMinutes: number;
  inactiveUserCleanupDays: number;
  allowGuestAccess: boolean;
}

export interface StorageConfig {
  totalStorageGB: number;
  usedStorageGB: number;
  maxFileSizeMB: number;
  allowedFileTypes: string[];
  enableFileVersioning: boolean;
  versionRetentionCount: number;
  compressionEnabled: boolean;
}

export interface ApiConfig {
  enabled: boolean;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  rateLimitPerDay: number;
  maxConcurrentRequests: number;
  apiKeys: ApiKeyConfig[];
  webhooksEnabled: boolean;
  webhookRetryCount: number;
  ipWhitelist: string[];
}

export interface ApiKeyConfig {
  id: string;
  name: string;
  keyHash: string; // hashed, never store plain
  prefix: string; // first 8 chars for identification
  permissions: string[];
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  createdBy: string;
  isActive: boolean;
}

export interface DataRetentionConfig {
  auditLogRetentionDays: number;
  activityLogRetentionDays: number;
  sensorDataRetentionDays: number;
  alertHistoryRetentionDays: number;
  deletedDataRetentionDays: number;
  backupRetentionDays: number;
  autoDeleteEnabled: boolean;
  archiveBeforeDelete: boolean;
}

export interface DomainConfig {
  customDomain?: string;
  customDomainVerified: boolean;
  customDomainVerificationToken?: string;
  subdomain?: string;
  sslCertificateExpiry?: Date;
  redirectToCustomDomain: boolean;
  allowedOrigins: string[];
}

export interface BrandingConfig {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headerColor: string;
  fontFamily: string;
  companyName: string;
  supportEmail?: string;
  supportPhone?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  customCss?: string;
  emailHeaderHtml?: string;
  emailFooterHtml?: string;
  loginBackgroundUrl?: string;
  showPoweredBy: boolean;
}

export interface TenantSecurityConfig {
  // Authentication
  mfaRequired: boolean;
  mfaRequiredForAdmins: boolean;
  allowedMfaMethods: ('totp' | 'sms' | 'email')[];

  // SSO
  ssoEnabled: boolean;
  ssoProvider?: 'saml' | 'oauth2' | 'oidc';
  ssoConfig?: SSOConfig;

  // Password Policy
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumbers: boolean;
  passwordRequireSpecialChars: boolean;
  passwordExpiryDays: number;
  passwordHistoryCount: number;
  preventCommonPasswords: boolean;

  // Access Control
  ipWhitelistEnabled: boolean;
  ipWhitelist: string[];
  ipBlacklistEnabled: boolean;
  ipBlacklist: string[];
  geoBlockingEnabled: boolean;
  allowedCountries: string[];
  blockedCountries: string[];

  // Session Management
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  sessionTimeoutMinutes: number;
  rememberMeDays: number;
  singleSessionPerUser: boolean;
  terminateSessionsOnPasswordChange: boolean;
}

export interface SSOConfig {
  entityId?: string;
  ssoUrl?: string;
  sloUrl?: string;
  certificate?: string;
  attributeMapping?: Record<string, string>;
  allowUnsolicitedResponse?: boolean;
  signAuthnRequest?: boolean;

  // OAuth/OIDC specific
  clientId?: string;
  clientSecretEncrypted?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scope?: string[];
  responseType?: string;
}

export interface TenantNotificationConfig {
  // Email
  emailEnabled: boolean;
  emailFromName?: string;
  emailFromAddress?: string;
  customSmtpEnabled: boolean;
  smtpConfig?: SmtpConfig;

  // SMS
  smsEnabled: boolean;
  smsProvider?: 'twilio' | 'nexmo' | 'aws_sns';
  smsConfig?: SmsConfig;

  // Push Notifications
  pushEnabled: boolean;
  pushProvider?: 'firebase' | 'onesignal' | 'pusher';
  pushConfig?: Record<string, unknown>;

  // Slack Integration
  slackEnabled: boolean;
  slackWebhookUrl?: string;
  slackDefaultChannel?: string;

  // Webhook Notifications
  webhookEnabled: boolean;
  webhooks: WebhookConfig[];

  // Notification Preferences
  digestFrequency: 'realtime' | 'hourly' | 'daily' | 'weekly';
  quietHoursEnabled: boolean;
  quietHoursStart?: string; // HH:mm format
  quietHoursEnd?: string;
  quietHoursTimezone?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  passwordEncrypted?: string;
  requireTls: boolean;
}

export interface SmsConfig {
  accountSid?: string;
  authTokenEncrypted?: string;
  fromNumber?: string;
  region?: string;
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: string[];
  secretEncrypted?: string;
  headers?: Record<string, string>;
  isActive: boolean;
  retryEnabled: boolean;
  retryCount: number;
  lastTriggeredAt?: Date;
  lastStatus?: 'success' | 'failed';
  createdAt: Date;
}

export interface FeatureFlagsConfig {
  // Module Access
  enabledModules: string[];

  // Feature Toggles
  advancedAnalytics: boolean;
  customReports: boolean;
  dataExport: boolean;
  dataImport: boolean;
  bulkOperations: boolean;
  auditLog: boolean;
  apiAccess: boolean;
  mobileAccess: boolean;
  offlineMode: boolean;

  // Integrations
  thirdPartyIntegrations: boolean;
  customIntegrations: boolean;
  iotDeviceSupport: boolean;

  // Beta Features
  betaFeatures: string[];

  // Overrides from plan
  planOverrides: Record<string, boolean>;
}

// ============================================================================
// Default Configuration Factory
// ============================================================================

export function createDefaultTenantConfiguration(tenantId: string): Partial<TenantConfiguration> {
  return {
    tenantId,
    userLimits: {
      maxUsers: 5,
      maxAdmins: 2,
      maxModuleManagers: 3,
      maxConcurrentSessions: 3,
      sessionTimeoutMinutes: 480,
      inactiveUserCleanupDays: 90,
      allowGuestAccess: false,
    },
    storageConfig: {
      totalStorageGB: 10,
      usedStorageGB: 0,
      maxFileSizeMB: 50,
      allowedFileTypes: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'jpeg', 'png', 'gif'],
      enableFileVersioning: false,
      versionRetentionCount: 3,
      compressionEnabled: true,
    },
    apiConfig: {
      enabled: false,
      rateLimitPerMinute: 100,
      rateLimitPerHour: 1000,
      rateLimitPerDay: 10000,
      maxConcurrentRequests: 10,
      apiKeys: [],
      webhooksEnabled: false,
      webhookRetryCount: 3,
      ipWhitelist: [],
    },
    dataRetention: {
      auditLogRetentionDays: 90,
      activityLogRetentionDays: 30,
      sensorDataRetentionDays: 365,
      alertHistoryRetentionDays: 180,
      deletedDataRetentionDays: 30,
      backupRetentionDays: 30,
      autoDeleteEnabled: true,
      archiveBeforeDelete: true,
    },
    domainConfig: {
      customDomainVerified: false,
      redirectToCustomDomain: false,
      allowedOrigins: [],
    },
    brandingConfig: {
      primaryColor: '#3B82F6',
      secondaryColor: '#6B7280',
      accentColor: '#10B981',
      headerColor: '#1F2937',
      fontFamily: 'Inter, system-ui, sans-serif',
      companyName: '',
      showPoweredBy: true,
    },
    securityConfig: {
      mfaRequired: false,
      mfaRequiredForAdmins: false,
      allowedMfaMethods: ['totp', 'email'],
      ssoEnabled: false,
      passwordMinLength: 8,
      passwordRequireUppercase: true,
      passwordRequireLowercase: true,
      passwordRequireNumbers: true,
      passwordRequireSpecialChars: false,
      passwordExpiryDays: 0, // 0 = never expires
      passwordHistoryCount: 3,
      preventCommonPasswords: true,
      ipWhitelistEnabled: false,
      ipWhitelist: [],
      ipBlacklistEnabled: false,
      ipBlacklist: [],
      geoBlockingEnabled: false,
      allowedCountries: [],
      blockedCountries: [],
      maxLoginAttempts: 5,
      lockoutDurationMinutes: 30,
      sessionTimeoutMinutes: 480,
      rememberMeDays: 30,
      singleSessionPerUser: false,
      terminateSessionsOnPasswordChange: true,
    },
    notificationConfig: {
      emailEnabled: true,
      customSmtpEnabled: false,
      smsEnabled: false,
      pushEnabled: false,
      slackEnabled: false,
      webhookEnabled: false,
      webhooks: [],
      digestFrequency: 'realtime',
      quietHoursEnabled: false,
    },
    featureFlags: {
      enabledModules: [],
      advancedAnalytics: false,
      customReports: false,
      dataExport: true,
      dataImport: false,
      bulkOperations: false,
      auditLog: true,
      apiAccess: false,
      mobileAccess: true,
      offlineMode: false,
      thirdPartyIntegrations: false,
      customIntegrations: false,
      iotDeviceSupport: true,
      betaFeatures: [],
      planOverrides: {},
    },
  };
}
