import * as crypto from 'crypto';

import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  ApiConfig,
  ApiKeyConfig,
  BrandingConfig,
  createDefaultTenantConfiguration,
  DataRetentionConfig,
  DomainConfig,
  FeatureFlagsConfig,
  StorageConfig,
  TenantConfiguration,
  TenantNotificationConfig,
  TenantSecurityConfig,
  UserLimitsConfig,
  WebhookConfig,
} from '../entities/tenant-configuration.entity';

export interface CreateTenantConfigurationDto {
  tenantId: string;
  userLimits?: Partial<UserLimitsConfig>;
  storageConfig?: Partial<StorageConfig>;
  apiConfig?: Partial<ApiConfig>;
  dataRetention?: Partial<DataRetentionConfig>;
  domainConfig?: Partial<DomainConfig>;
  brandingConfig?: Partial<BrandingConfig>;
  securityConfig?: Partial<TenantSecurityConfig>;
  notificationConfig?: Partial<TenantNotificationConfig>;
  featureFlags?: Partial<FeatureFlagsConfig>;
}

export interface UpdateTenantConfigurationDto {
  userLimits?: Partial<UserLimitsConfig>;
  storageConfig?: Partial<StorageConfig>;
  apiConfig?: Partial<ApiConfig>;
  dataRetention?: Partial<DataRetentionConfig>;
  domainConfig?: Partial<DomainConfig>;
  brandingConfig?: Partial<BrandingConfig>;
  securityConfig?: Partial<TenantSecurityConfig>;
  notificationConfig?: Partial<TenantNotificationConfig>;
  featureFlags?: Partial<FeatureFlagsConfig>;
  updatedBy?: string;
}

export interface CreateApiKeyDto {
  name: string;
  permissions: string[];
  expiresAt?: Date;
  createdBy: string;
}

export interface CreateWebhookDto {
  name: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
  retryEnabled?: boolean;
  retryCount?: number;
}

export interface VerifyDomainDto {
  customDomain: string;
}

export interface UpdateBrandingDto {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  headerColor?: string;
  fontFamily?: string;
  companyName?: string;
  supportEmail?: string;
  supportPhone?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  customCss?: string;
  loginBackgroundUrl?: string;
  showPoweredBy?: boolean;
}

export interface TenantConfigurationProvisioningRequest {
  requestId: string;
  tenantId: string;
  targetService: 'config-service';
  status: 'REQUESTED';
  sections: Array<keyof UpdateTenantConfigurationDto>;
  requestedAt: string;
}

const LEGACY_CONFIG_STORE_GONE =
  'admin-api direct tenant_configurations writes are retired; use config-service effective configuration APIs';

@Injectable()
export class TenantConfigurationService {
  private readonly logger = new Logger(TenantConfigurationService.name);

  async requestDefaultConfigurationProvisioning(
    dto: CreateTenantConfigurationDto,
  ): Promise<TenantConfigurationProvisioningRequest> {
    const sections = Object.keys(dto).filter((key) => key !== 'tenantId') as Array<
      keyof UpdateTenantConfigurationDto
    >;
    const request: TenantConfigurationProvisioningRequest = {
      requestId: crypto.randomUUID(),
      tenantId: dto.tenantId,
      targetService: 'config-service',
      status: 'REQUESTED',
      sections,
      requestedAt: new Date().toISOString(),
    };
    this.logger.log(
      `Requested config-service default configuration for tenant ${dto.tenantId} (${request.requestId})`,
    );
    return request;
  }

  async createConfiguration(_dto: CreateTenantConfigurationDto): Promise<TenantConfiguration> {
    this.throwLegacyGone();
  }

  async getConfigurationByTenantId(tenantId: string): Promise<TenantConfiguration> {
    return this.defaultConfiguration(tenantId);
  }

  async getOrCreateConfiguration(tenantId: string): Promise<TenantConfiguration> {
    return this.getConfigurationByTenantId(tenantId);
  }

  async updateConfiguration(
    _tenantId: string,
    _dto: UpdateTenantConfigurationDto,
  ): Promise<TenantConfiguration> {
    this.throwLegacyGone();
  }

  async deleteConfiguration(_tenantId: string): Promise<void> {
    this.throwLegacyGone();
  }

  async getUserLimits(tenantId: string): Promise<UserLimitsConfig> {
    return this.defaultConfiguration(tenantId).userLimits;
  }

  async updateUserLimits(
    _tenantId: string,
    _limits: Partial<UserLimitsConfig>,
    _updatedBy?: string,
  ): Promise<UserLimitsConfig> {
    this.throwLegacyGone();
  }

  async getStorageConfig(tenantId: string): Promise<StorageConfig> {
    return this.defaultConfiguration(tenantId).storageConfig;
  }

  async updateStorageConfig(
    _tenantId: string,
    _storage: Partial<StorageConfig>,
    _updatedBy?: string,
  ): Promise<StorageConfig> {
    this.throwLegacyGone();
  }

  async updateStorageUsage(_tenantId: string, _usedStorageGB: number): Promise<void> {
    this.throwLegacyGone();
  }

  async checkStorageLimit(tenantId: string, additionalSizeGB: number): Promise<boolean> {
    const storage = await this.getStorageConfig(tenantId);
    return storage.usedStorageGB + additionalSizeGB <= storage.totalStorageGB;
  }

  async getApiConfig(tenantId: string): Promise<ApiConfig> {
    return this.defaultConfiguration(tenantId).apiConfig;
  }

  async updateApiConfig(
    _tenantId: string,
    _apiConfig: Partial<ApiConfig>,
    _updatedBy?: string,
  ): Promise<ApiConfig> {
    this.throwLegacyGone();
  }

  async createApiKey(
    _tenantId: string,
    _dto: CreateApiKeyDto,
  ): Promise<{ apiKey: string; keyConfig: ApiKeyConfig }> {
    this.throwLegacyGone();
  }

  async revokeApiKey(_tenantId: string, _keyId: string): Promise<void> {
    this.throwLegacyGone();
  }

  async validateApiKey(_tenantId: string, _rawKey: string): Promise<ApiKeyConfig | null> {
    throw new NotFoundException('Tenant API keys are not exposed by the legacy adapter');
  }

  async getWebhooks(tenantId: string): Promise<WebhookConfig[]> {
    return this.defaultConfiguration(tenantId).notificationConfig.webhooks;
  }

  async createWebhook(_tenantId: string, _dto: CreateWebhookDto): Promise<WebhookConfig> {
    this.throwLegacyGone();
  }

  async updateWebhook(
    _tenantId: string,
    _webhookId: string,
    _updates: Partial<CreateWebhookDto>,
  ): Promise<WebhookConfig> {
    this.throwLegacyGone();
  }

  async deleteWebhook(_tenantId: string, _webhookId: string): Promise<void> {
    this.throwLegacyGone();
  }

  async getDomainConfig(tenantId: string): Promise<DomainConfig> {
    return this.defaultConfiguration(tenantId).domainConfig;
  }

  async initiateCustomDomainVerification(
    _tenantId: string,
    _dto: VerifyDomainDto,
  ): Promise<{ verificationToken: string; dnsRecord: string }> {
    this.throwLegacyGone();
  }

  async verifyCustomDomain(_tenantId: string): Promise<boolean> {
    this.throwLegacyGone();
  }

  async getBrandingConfig(tenantId: string): Promise<BrandingConfig> {
    return this.defaultConfiguration(tenantId).brandingConfig;
  }

  async updateBranding(
    _tenantId: string,
    _dto: UpdateBrandingDto,
    _updatedBy?: string,
  ): Promise<BrandingConfig> {
    this.throwLegacyGone();
  }

  async getSecurityConfig(tenantId: string): Promise<TenantSecurityConfig> {
    return this.defaultConfiguration(tenantId).securityConfig;
  }

  async updateSecurityConfig(
    _tenantId: string,
    _security: Partial<TenantSecurityConfig>,
    _updatedBy?: string,
  ): Promise<TenantSecurityConfig> {
    this.throwLegacyGone();
  }

  async addToIpWhitelist(_tenantId: string, _ip: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async removeFromIpWhitelist(_tenantId: string, _ip: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async addToIpBlacklist(_tenantId: string, _ip: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async removeFromIpBlacklist(_tenantId: string, _ip: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async getNotificationConfig(tenantId: string): Promise<TenantNotificationConfig> {
    return this.defaultConfiguration(tenantId).notificationConfig;
  }

  async updateNotificationConfig(
    _tenantId: string,
    _notification: Partial<TenantNotificationConfig>,
    _updatedBy?: string,
  ): Promise<TenantNotificationConfig> {
    this.throwLegacyGone();
  }

  async getFeatureFlags(tenantId: string): Promise<FeatureFlagsConfig> {
    return this.defaultConfiguration(tenantId).featureFlags;
  }

  async updateFeatureFlags(
    _tenantId: string,
    _flags: Partial<FeatureFlagsConfig>,
    _updatedBy?: string,
  ): Promise<FeatureFlagsConfig> {
    this.throwLegacyGone();
  }

  async enableModule(_tenantId: string, _moduleCode: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async disableModule(_tenantId: string, _moduleCode: string): Promise<string[]> {
    this.throwLegacyGone();
  }

  async getDataRetentionConfig(tenantId: string): Promise<DataRetentionConfig> {
    return this.defaultConfiguration(tenantId).dataRetention;
  }

  async updateDataRetentionConfig(
    _tenantId: string,
    _retention: Partial<DataRetentionConfig>,
    _updatedBy?: string,
  ): Promise<DataRetentionConfig> {
    this.throwLegacyGone();
  }

  async getConfigurationSummary(tenantId: string): Promise<{
    userLimits: { current: number; max: number };
    storage: { used: number; total: number };
    apiEnabled: boolean;
    apiKeyCount: number;
    webhookCount: number;
    customDomain: string | null;
    mfaRequired: boolean;
    enabledModules: string[];
  }> {
    const config = this.defaultConfiguration(tenantId);
    return {
      userLimits: { current: 0, max: config.userLimits.maxUsers },
      storage: {
        used: config.storageConfig.usedStorageGB,
        total: config.storageConfig.totalStorageGB,
      },
      apiEnabled: config.apiConfig.enabled,
      apiKeyCount: 0,
      webhookCount: 0,
      customDomain: null,
      mfaRequired: config.securityConfig.mfaRequired,
      enabledModules: config.featureFlags.enabledModules,
    };
  }

  private defaultConfiguration(tenantId: string): TenantConfiguration {
    const defaults = createDefaultTenantConfiguration(tenantId);
    return {
      ...defaults,
      id: `legacy:${tenantId}`,
      tenantId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as TenantConfiguration;
  }

  private throwLegacyGone(): never {
    throw new GoneException(LEGACY_CONFIG_STORE_GONE);
  }
}
