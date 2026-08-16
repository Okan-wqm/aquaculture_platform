import * as crypto from 'crypto';

import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  ApiConfig,
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
import {
  CreateApiKeyDto,
  CreateTenantConfigurationDto,
  CreateWebhookDto,
  UpdateBrandingDto,
  UpdateTenantConfigurationDto,
  VerifyDomainDto,
} from '../dto/tenant-configuration.dto';

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

  requestDefaultConfigurationProvisioning(
    dto: CreateTenantConfigurationDto,
  ): TenantConfigurationProvisioningRequest {
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

  createConfiguration(_dto: CreateTenantConfigurationDto): never {
    this.throwLegacyGone();
  }

  getConfigurationByTenantId(tenantId: string): TenantConfiguration {
    return this.defaultConfiguration(tenantId);
  }

  getOrCreateConfiguration(tenantId: string): TenantConfiguration {
    return this.getConfigurationByTenantId(tenantId);
  }

  updateConfiguration(_tenantId: string, _dto: UpdateTenantConfigurationDto): never {
    this.throwLegacyGone();
  }

  deleteConfiguration(_tenantId: string): never {
    this.throwLegacyGone();
  }

  getUserLimits(tenantId: string): UserLimitsConfig {
    return this.defaultConfiguration(tenantId).userLimits;
  }

  updateUserLimits(
    _tenantId: string,
    _limits: Partial<UserLimitsConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getStorageConfig(tenantId: string): StorageConfig {
    return this.defaultConfiguration(tenantId).storageConfig;
  }

  updateStorageConfig(
    _tenantId: string,
    _storage: Partial<StorageConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  updateStorageUsage(_tenantId: string, _usedStorageGB: number): never {
    this.throwLegacyGone();
  }

  checkStorageLimit(tenantId: string, additionalSizeGB: number): boolean {
    const storage = this.getStorageConfig(tenantId);
    return storage.usedStorageGB + additionalSizeGB <= storage.totalStorageGB;
  }

  getApiConfig(tenantId: string): ApiConfig {
    return this.defaultConfiguration(tenantId).apiConfig;
  }

  updateApiConfig(_tenantId: string, _apiConfig: Partial<ApiConfig>, _updatedBy?: string): never {
    this.throwLegacyGone();
  }

  createApiKey(_tenantId: string, _dto: CreateApiKeyDto): never {
    this.throwLegacyGone();
  }

  revokeApiKey(_tenantId: string, _keyId: string): never {
    this.throwLegacyGone();
  }

  validateApiKey(_tenantId: string, _rawKey: string): never {
    throw new NotFoundException('Tenant API keys are not exposed by the legacy adapter');
  }

  getWebhooks(tenantId: string): WebhookConfig[] {
    return this.defaultConfiguration(tenantId).notificationConfig.webhooks;
  }

  createWebhook(_tenantId: string, _dto: CreateWebhookDto): never {
    this.throwLegacyGone();
  }

  updateWebhook(_tenantId: string, _webhookId: string, _updates: Partial<CreateWebhookDto>): never {
    this.throwLegacyGone();
  }

  deleteWebhook(_tenantId: string, _webhookId: string): never {
    this.throwLegacyGone();
  }

  getDomainConfig(tenantId: string): DomainConfig {
    return this.defaultConfiguration(tenantId).domainConfig;
  }

  initiateCustomDomainVerification(_tenantId: string, _dto: VerifyDomainDto): never {
    this.throwLegacyGone();
  }

  verifyCustomDomain(_tenantId: string): never {
    this.throwLegacyGone();
  }

  getBrandingConfig(tenantId: string): BrandingConfig {
    return this.defaultConfiguration(tenantId).brandingConfig;
  }

  updateBranding(_tenantId: string, _dto: UpdateBrandingDto, _updatedBy?: string): never {
    this.throwLegacyGone();
  }

  getSecurityConfig(tenantId: string): TenantSecurityConfig {
    return this.defaultConfiguration(tenantId).securityConfig;
  }

  updateSecurityConfig(
    _tenantId: string,
    _security: Partial<TenantSecurityConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  addToIpWhitelist(_tenantId: string, _ip: string): never {
    this.throwLegacyGone();
  }

  removeFromIpWhitelist(_tenantId: string, _ip: string): never {
    this.throwLegacyGone();
  }

  addToIpBlacklist(_tenantId: string, _ip: string): never {
    this.throwLegacyGone();
  }

  removeFromIpBlacklist(_tenantId: string, _ip: string): never {
    this.throwLegacyGone();
  }

  getNotificationConfig(tenantId: string): TenantNotificationConfig {
    return this.defaultConfiguration(tenantId).notificationConfig;
  }

  updateNotificationConfig(
    _tenantId: string,
    _notification: Partial<TenantNotificationConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getFeatureFlags(tenantId: string): FeatureFlagsConfig {
    return this.defaultConfiguration(tenantId).featureFlags;
  }

  updateFeatureFlags(
    _tenantId: string,
    _flags: Partial<FeatureFlagsConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  enableModule(_tenantId: string, _moduleCode: string): never {
    this.throwLegacyGone();
  }

  disableModule(_tenantId: string, _moduleCode: string): never {
    this.throwLegacyGone();
  }

  getDataRetentionConfig(tenantId: string): DataRetentionConfig {
    return this.defaultConfiguration(tenantId).dataRetention;
  }

  updateDataRetentionConfig(
    _tenantId: string,
    _retention: Partial<DataRetentionConfig>,
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getConfigurationSummary(tenantId: string): {
    userLimits: { current: number; max: number };
    storage: { used: number; total: number };
    apiEnabled: boolean;
    apiKeyCount: number;
    webhookCount: number;
    customDomain: string | null;
    mfaRequired: boolean;
    enabledModules: string[];
  } {
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
