import {
  IsOptional,
  IsBoolean,
  IsNumber,
  IsString,
  IsArray,
  IsIP,
  IsIn,
  Min,
  Max,
  MaxLength,
  IsEmail,
  IsUrl,
  IsDate,
  IsObject,
  IsUUID,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================================
// User Limits
// ============================================================================

export class UpdateUserLimitsDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  maxUsers?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  maxAdmins?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  maxModuleManagers?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10080) // 1 week in minutes
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  inactiveUserCleanupDays?: number;

  @IsOptional()
  @IsBoolean()
  allowGuestAccess?: boolean;
}

// ============================================================================
// Storage
// ============================================================================

export class UpdateStorageConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  totalStorageGB?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  usedStorageGB?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5000)
  maxFileSizeMB?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  allowedFileTypes?: string[];

  @IsOptional()
  @IsBoolean()
  enableFileVersioning?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  versionRetentionCount?: number;

  @IsOptional()
  @IsBoolean()
  compressionEnabled?: boolean;
}

export class CheckStorageLimitDto {
  @IsNumber()
  @Min(0)
  additionalSizeGB!: number;
}

// ============================================================================
// API Config
// ============================================================================

export class UpdateApiConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100000)
  rateLimitPerMinute?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000000)
  rateLimitPerHour?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000000)
  rateLimitPerDay?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  maxConcurrentRequests?: number;

  @IsOptional()
  @IsBoolean()
  webhooksEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  webhookRetryCount?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  ipWhitelist?: string[];
}

export class ValidateApiKeyDto {
  @IsString()
  @MaxLength(512)
  apiKey!: string;
}

// ============================================================================
// Webhooks
// ============================================================================

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  events?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  retryEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  retryCount?: number;
}

// ============================================================================
// Security
// ============================================================================

export class UpdateTenantSecurityDto {
  @IsOptional()
  @IsBoolean()
  mfaRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  mfaRequiredForAdmins?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(['totp', 'sms', 'email'], { each: true })
  allowedMfaMethods?: ('totp' | 'sms' | 'email')[];

  @IsOptional()
  @IsBoolean()
  ssoEnabled?: boolean;

  @IsOptional()
  @IsIn(['saml', 'oauth2', 'oidc'])
  ssoProvider?: 'saml' | 'oauth2' | 'oidc';

  @IsOptional()
  @IsNumber()
  @Min(6)
  @Max(128)
  passwordMinLength?: number;

  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireLowercase?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireNumbers?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireSpecialChars?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  passwordExpiryDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  passwordHistoryCount?: number;

  @IsOptional()
  @IsBoolean()
  preventCommonPasswords?: boolean;

  @IsOptional()
  @IsBoolean()
  ipWhitelistEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  ipWhitelist?: string[];

  @IsOptional()
  @IsBoolean()
  ipBlacklistEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  ipBlacklist?: string[];

  @IsOptional()
  @IsBoolean()
  geoBlockingEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(250)
  allowedCountries?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(250)
  blockedCountries?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  maxLoginAttempts?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1440)
  lockoutDurationMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10080)
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  rememberMeDays?: number;

  @IsOptional()
  @IsBoolean()
  singleSessionPerUser?: boolean;

  @IsOptional()
  @IsBoolean()
  terminateSessionsOnPasswordChange?: boolean;
}

export class IpAddressDto {
  @IsIP()
  ip!: string;
}

// ============================================================================
// Notifications
// ============================================================================

export class UpdateNotificationConfigDto {
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  emailFromName?: string;

  @IsOptional()
  @IsEmail()
  emailFromAddress?: string;

  @IsOptional()
  @IsBoolean()
  customSmtpEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @IsOptional()
  @IsIn(['twilio', 'nexmo', 'aws_sns'])
  smsProvider?: 'twilio' | 'nexmo' | 'aws_sns';

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsIn(['firebase', 'onesignal', 'pusher'])
  pushProvider?: 'firebase' | 'onesignal' | 'pusher';

  @IsOptional()
  @IsBoolean()
  slackEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  slackWebhookUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slackDefaultChannel?: string;

  @IsOptional()
  @IsBoolean()
  webhookEnabled?: boolean;

  @IsOptional()
  @IsIn(['realtime', 'hourly', 'daily', 'weekly'])
  digestFrequency?: 'realtime' | 'hourly' | 'daily' | 'weekly';

  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  quietHoursStart?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  quietHoursEnd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  quietHoursTimezone?: string;
}

// ============================================================================
// Feature Flags
// ============================================================================

export class UpdateFeatureFlagsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  enabledModules?: string[];

  @IsOptional()
  @IsBoolean()
  advancedAnalytics?: boolean;

  @IsOptional()
  @IsBoolean()
  customReports?: boolean;

  @IsOptional()
  @IsBoolean()
  dataExport?: boolean;

  @IsOptional()
  @IsBoolean()
  dataImport?: boolean;

  @IsOptional()
  @IsBoolean()
  bulkOperations?: boolean;

  @IsOptional()
  @IsBoolean()
  auditLog?: boolean;

  @IsOptional()
  @IsBoolean()
  apiAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  mobileAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  offlineMode?: boolean;

  @IsOptional()
  @IsBoolean()
  thirdPartyIntegrations?: boolean;

  @IsOptional()
  @IsBoolean()
  customIntegrations?: boolean;

  @IsOptional()
  @IsBoolean()
  iotDeviceSupport?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  betaFeatures?: string[];
}

// ============================================================================
// Data Retention
// ============================================================================

export class UpdateDataRetentionDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3650) // 10 years
  auditLogRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3650)
  activityLogRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3650)
  sensorDataRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3650)
  alertHistoryRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  deletedDataRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  backupRetentionDays?: number;

  @IsOptional()
  @IsBoolean()
  autoDeleteEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  archiveBeforeDelete?: boolean;
}

export class UpdateDomainConfigDto {
  @IsOptional() @IsString() @MaxLength(255) customDomain?: string;
  @IsOptional() @IsBoolean() customDomainVerified?: boolean;
  @IsOptional() @IsString() @MaxLength(512) customDomainVerificationToken?: string;
  @IsOptional() @IsString() @MaxLength(100) subdomain?: string;
  @IsOptional() @Type(() => Date) @IsDate() sslCertificateExpiry?: Date;
  @IsOptional() @IsBoolean() redirectToCustomDomain?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(100) allowedOrigins?: string[];
}

export class UpdateBrandingDto {
  @IsOptional() @IsUrl({ require_tld: false }) logoUrl?: string;
  @IsOptional() @IsUrl({ require_tld: false }) faviconUrl?: string;
  @IsOptional() @IsString() @MaxLength(32) primaryColor?: string;
  @IsOptional() @IsString() @MaxLength(32) secondaryColor?: string;
  @IsOptional() @IsString() @MaxLength(32) accentColor?: string;
  @IsOptional() @IsString() @MaxLength(32) headerColor?: string;
  @IsOptional() @IsString() @MaxLength(255) fontFamily?: string;
  @IsOptional() @IsString() @MaxLength(255) companyName?: string;
  @IsOptional() @IsEmail() supportEmail?: string;
  @IsOptional() @IsString() @MaxLength(50) supportPhone?: string;
  @IsOptional() @IsUrl({ require_tld: false }) privacyPolicyUrl?: string;
  @IsOptional() @IsUrl({ require_tld: false }) termsOfServiceUrl?: string;
  @IsOptional() @IsString() @MaxLength(100000) customCss?: string;
  @IsOptional() @IsUrl({ require_tld: false }) loginBackgroundUrl?: string;
  @IsOptional() @IsBoolean() showPoweredBy?: boolean;
}

export class TenantConfigurationSectionsDto {
  @IsOptional() @ValidateNested() @Type(() => UpdateUserLimitsDto) userLimits?: UpdateUserLimitsDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateStorageConfigDto)
  storageConfig?: UpdateStorageConfigDto;
  @IsOptional() @ValidateNested() @Type(() => UpdateApiConfigDto) apiConfig?: UpdateApiConfigDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDataRetentionDto)
  dataRetention?: UpdateDataRetentionDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDomainConfigDto)
  domainConfig?: UpdateDomainConfigDto;
  @IsOptional() @ValidateNested() @Type(() => UpdateBrandingDto) brandingConfig?: UpdateBrandingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateTenantSecurityDto)
  securityConfig?: UpdateTenantSecurityDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateNotificationConfigDto)
  notificationConfig?: UpdateNotificationConfigDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateFeatureFlagsDto)
  featureFlags?: UpdateFeatureFlagsDto;
}

export class CreateTenantConfigurationDto extends TenantConfigurationSectionsDto {
  @IsUUID('4')
  tenantId!: string;
}

export class UpdateTenantConfigurationDto extends TenantConfigurationSectionsDto {}

export class CreateApiKeyDto {
  @IsString() @MaxLength(255) name!: string;
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(100) permissions!: string[];
  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
}

export class CreateWebhookDto {
  @IsString() @MaxLength(255) name!: string;
  @IsUrl({ require_tld: false }) url!: string;
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(100) events!: string[];
  @IsOptional() @IsString() @MaxLength(512) secret?: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsBoolean() retryEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(10) retryCount?: number;
}

export class VerifyDomainDto {
  @IsString()
  @MaxLength(255)
  customDomain!: string;
}
