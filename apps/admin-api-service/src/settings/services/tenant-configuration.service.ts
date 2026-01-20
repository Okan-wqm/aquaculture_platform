import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TenantConfiguration,
  createDefaultTenantConfiguration,
  UserLimitsConfig,
  StorageConfig,
  ApiConfig,
  DataRetentionConfig,
  DomainConfig,
  BrandingConfig,
  TenantSecurityConfig,
  TenantNotificationConfig,
  FeatureFlagsConfig,
  ApiKeyConfig,
  WebhookConfig,
} from '../entities/tenant-configuration.entity';
import * as crypto from 'crypto';

// ============================================================================
// DTOs
// ============================================================================

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

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class TenantConfigurationService {
  private readonly logger = new Logger(TenantConfigurationService.name);

  constructor(
    @InjectRepository(TenantConfiguration)
    private readonly configRepository: Repository<TenantConfiguration>,
  ) {}

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Create default configuration for a new tenant
   */
  async createConfiguration(dto: CreateTenantConfigurationDto): Promise<TenantConfiguration> {
    // Check if configuration already exists
    const existing = await this.configRepository.findOne({
      where: { tenantId: dto.tenantId },
    });

    if (existing) {
      throw new ConflictException(`Configuration for tenant ${dto.tenantId} already exists`);
    }

    // Create with defaults and merge provided values
    const defaults = createDefaultTenantConfiguration(dto.tenantId);

    const config = this.configRepository.create({
      ...defaults,
      userLimits: { ...defaults.userLimits, ...dto.userLimits } as UserLimitsConfig,
      storageConfig: { ...defaults.storageConfig, ...dto.storageConfig } as StorageConfig,
      apiConfig: { ...defaults.apiConfig, ...dto.apiConfig } as ApiConfig,
      dataRetention: { ...defaults.dataRetention, ...dto.dataRetention } as DataRetentionConfig,
      domainConfig: { ...defaults.domainConfig, ...dto.domainConfig } as DomainConfig,
      brandingConfig: { ...defaults.brandingConfig, ...dto.brandingConfig } as BrandingConfig,
      securityConfig: { ...defaults.securityConfig, ...dto.securityConfig } as TenantSecurityConfig,
      notificationConfig: { ...defaults.notificationConfig, ...dto.notificationConfig } as TenantNotificationConfig,
      featureFlags: { ...defaults.featureFlags, ...dto.featureFlags } as FeatureFlagsConfig,
    });

    const saved = await this.configRepository.save(config);
    this.logger.log(`Created configuration for tenant: ${dto.tenantId}`);
    return saved;
  }

  /**
   * Get configuration by tenant ID
   */
  async getConfigurationByTenantId(tenantId: string): Promise<TenantConfiguration> {
    const config = await this.configRepository.findOne({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(`Configuration for tenant ${tenantId} not found`);
    }

    return config;
  }

  /**
   * Get or create configuration for tenant
   */
  async getOrCreateConfiguration(tenantId: string): Promise<TenantConfiguration> {
    try {
      return await this.getConfigurationByTenantId(tenantId);
    } catch {
      return await this.createConfiguration({ tenantId });
    }
  }

  /**
   * Update configuration
   */
  async updateConfiguration(
    tenantId: string,
    dto: UpdateTenantConfigurationDto,
  ): Promise<TenantConfiguration> {
    const config = await this.getConfigurationByTenantId(tenantId);

    // Deep merge each section
    if (dto.userLimits) {
      config.userLimits = { ...config.userLimits, ...dto.userLimits };
    }
    if (dto.storageConfig) {
      config.storageConfig = { ...config.storageConfig, ...dto.storageConfig };
    }
    if (dto.apiConfig) {
      config.apiConfig = { ...config.apiConfig, ...dto.apiConfig };
    }
    if (dto.dataRetention) {
      config.dataRetention = { ...config.dataRetention, ...dto.dataRetention };
    }
    if (dto.domainConfig) {
      config.domainConfig = { ...config.domainConfig, ...dto.domainConfig };
    }
    if (dto.brandingConfig) {
      config.brandingConfig = { ...config.brandingConfig, ...dto.brandingConfig };
    }
    if (dto.securityConfig) {
      config.securityConfig = { ...config.securityConfig, ...dto.securityConfig };
    }
    if (dto.notificationConfig) {
      config.notificationConfig = { ...config.notificationConfig, ...dto.notificationConfig };
    }
    if (dto.featureFlags) {
      config.featureFlags = { ...config.featureFlags, ...dto.featureFlags };
    }

    if (dto.updatedBy) {
      config.updatedBy = dto.updatedBy;
    }

    const saved = await this.configRepository.save(config);
    this.logger.log(`Updated configuration for tenant: ${tenantId}`);
    return saved;
  }

  /**
   * Delete configuration (typically when tenant is deleted)
   */
  async deleteConfiguration(tenantId: string): Promise<void> {
    const config = await this.getConfigurationByTenantId(tenantId);
    await this.configRepository.remove(config);
    this.logger.log(`Deleted configuration for tenant: ${tenantId}`);
  }

  // ============================================================================
  // User Limits Management
  // ============================================================================

  async getUserLimits(tenantId: string): Promise<UserLimitsConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.userLimits;
  }

  async updateUserLimits(
    tenantId: string,
    limits: Partial<UserLimitsConfig>,
    updatedBy?: string,
  ): Promise<UserLimitsConfig> {
    const config = await this.updateConfiguration(tenantId, {
      userLimits: limits,
      updatedBy,
    });
    return config.userLimits;
  }

  // ============================================================================
  // Storage Management
  // ============================================================================

  async getStorageConfig(tenantId: string): Promise<StorageConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.storageConfig;
  }

  async updateStorageConfig(
    tenantId: string,
    storage: Partial<StorageConfig>,
    updatedBy?: string,
  ): Promise<StorageConfig> {
    const config = await this.updateConfiguration(tenantId, {
      storageConfig: storage,
      updatedBy,
    });
    return config.storageConfig;
  }

  async updateStorageUsage(tenantId: string, usedStorageGB: number): Promise<void> {
    await this.updateStorageConfig(tenantId, { usedStorageGB });
  }

  async checkStorageLimit(tenantId: string, additionalSizeGB: number): Promise<boolean> {
    const storage = await this.getStorageConfig(tenantId);
    return (storage.usedStorageGB + additionalSizeGB) <= storage.totalStorageGB;
  }

  // ============================================================================
  // API Configuration
  // ============================================================================

  async getApiConfig(tenantId: string): Promise<ApiConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.apiConfig;
  }

  async updateApiConfig(
    tenantId: string,
    apiConfig: Partial<ApiConfig>,
    updatedBy?: string,
  ): Promise<ApiConfig> {
    const config = await this.updateConfiguration(tenantId, {
      apiConfig,
      updatedBy,
    });
    return config.apiConfig;
  }

  /**
   * Generate a new API key for tenant
   */
  async createApiKey(
    tenantId: string,
    dto: CreateApiKeyDto,
  ): Promise<{ apiKey: string; keyConfig: ApiKeyConfig }> {
    const config = await this.getConfigurationByTenantId(tenantId);

    // Generate API key
    const rawKey = crypto.randomBytes(32).toString('hex');
    const prefix = rawKey.substring(0, 8);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const keyConfig: ApiKeyConfig = {
      id: crypto.randomUUID(),
      name: dto.name,
      keyHash,
      prefix,
      permissions: dto.permissions,
      expiresAt: dto.expiresAt,
      createdAt: new Date(),
      createdBy: dto.createdBy,
      isActive: true,
    };

    config.apiConfig.apiKeys.push(keyConfig);
    await this.configRepository.save(config);

    this.logger.log(`Created API key "${dto.name}" for tenant: ${tenantId}`);

    // Return the raw key (only time it's available)
    return {
      apiKey: `aq_${rawKey}`,
      keyConfig: { ...keyConfig, keyHash: '***' }, // Don't return hash
    };
  }

  /**
   * Revoke an API key
   */
  async revokeApiKey(tenantId: string, keyId: string): Promise<void> {
    const config = await this.getConfigurationByTenantId(tenantId);

    const keyIndex = config.apiConfig.apiKeys.findIndex(k => k.id === keyId);
    if (keyIndex === -1) {
      throw new NotFoundException(`API key ${keyId} not found`);
    }

    const apiKey = config.apiConfig.apiKeys[keyIndex];
    if (apiKey) {
      apiKey.isActive = false;
    }
    await this.configRepository.save(config);

    this.logger.log(`Revoked API key ${keyId} for tenant: ${tenantId}`);
  }

  /**
   * Validate an API key
   */
  async validateApiKey(tenantId: string, rawKey: string): Promise<ApiKeyConfig | null> {
    const config = await this.getConfigurationByTenantId(tenantId);

    // Remove prefix if present
    const keyToHash = rawKey.startsWith('aq_') ? rawKey.substring(3) : rawKey;
    const keyHash = crypto.createHash('sha256').update(keyToHash).digest('hex');

    const key = config.apiConfig.apiKeys.find(
      k => k.keyHash === keyHash && k.isActive
    );

    if (!key) return null;

    // Check expiry
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return null;
    }

    // Update last used
    key.lastUsedAt = new Date();
    await this.configRepository.save(config);

    return key;
  }

  // ============================================================================
  // Webhook Management
  // ============================================================================

  async getWebhooks(tenantId: string): Promise<WebhookConfig[]> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.notificationConfig.webhooks;
  }

  async createWebhook(tenantId: string, dto: CreateWebhookDto): Promise<WebhookConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);

    const webhook: WebhookConfig = {
      id: crypto.randomUUID(),
      name: dto.name,
      url: dto.url,
      events: dto.events,
      secretEncrypted: dto.secret ? this.encryptValue(dto.secret) : undefined,
      headers: dto.headers,
      isActive: true,
      retryEnabled: dto.retryEnabled ?? true,
      retryCount: dto.retryCount ?? 3,
      createdAt: new Date(),
    };

    config.notificationConfig.webhooks.push(webhook);
    config.notificationConfig.webhookEnabled = true;
    await this.configRepository.save(config);

    this.logger.log(`Created webhook "${dto.name}" for tenant: ${tenantId}`);
    return { ...webhook, secretEncrypted: webhook.secretEncrypted ? '***' : undefined };
  }

  async updateWebhook(
    tenantId: string,
    webhookId: string,
    updates: Partial<CreateWebhookDto>,
  ): Promise<WebhookConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);

    const webhookIndex = config.notificationConfig.webhooks.findIndex(w => w.id === webhookId);
    if (webhookIndex === -1) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }

    const webhook = config.notificationConfig.webhooks[webhookIndex];

    if (!webhook) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }

    if (updates.name) webhook.name = updates.name;
    if (updates.url) webhook.url = updates.url;
    if (updates.events) webhook.events = updates.events;
    if (updates.secret) webhook.secretEncrypted = this.encryptValue(updates.secret);
    if (updates.headers) webhook.headers = updates.headers;
    if (updates.retryEnabled !== undefined) webhook.retryEnabled = updates.retryEnabled;
    if (updates.retryCount !== undefined) webhook.retryCount = updates.retryCount;

    await this.configRepository.save(config);
    return { ...webhook, secretEncrypted: webhook.secretEncrypted ? '***' : undefined } as WebhookConfig;
  }

  async deleteWebhook(tenantId: string, webhookId: string): Promise<void> {
    const config = await this.getConfigurationByTenantId(tenantId);

    const initialLength = config.notificationConfig.webhooks.length;
    config.notificationConfig.webhooks = config.notificationConfig.webhooks.filter(
      w => w.id !== webhookId
    );

    if (config.notificationConfig.webhooks.length === initialLength) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }

    if (config.notificationConfig.webhooks.length === 0) {
      config.notificationConfig.webhookEnabled = false;
    }

    await this.configRepository.save(config);
    this.logger.log(`Deleted webhook ${webhookId} for tenant: ${tenantId}`);
  }

  // ============================================================================
  // Domain & Branding
  // ============================================================================

  async getDomainConfig(tenantId: string): Promise<DomainConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.domainConfig;
  }

  async initiateCustomDomainVerification(
    tenantId: string,
    dto: VerifyDomainDto,
  ): Promise<{ verificationToken: string; dnsRecord: string }> {
    const config = await this.getConfigurationByTenantId(tenantId);

    const verificationToken = crypto.randomBytes(32).toString('hex');

    config.domainConfig.customDomain = dto.customDomain;
    config.domainConfig.customDomainVerified = false;
    config.domainConfig.customDomainVerificationToken = verificationToken;

    await this.configRepository.save(config);

    return {
      verificationToken,
      dnsRecord: `TXT _aquaculture-verification.${dto.customDomain} = ${verificationToken}`,
    };
  }

  async verifyCustomDomain(tenantId: string): Promise<boolean> {
    const config = await this.getConfigurationByTenantId(tenantId);

    if (!config.domainConfig.customDomain || !config.domainConfig.customDomainVerificationToken) {
      throw new BadRequestException('No pending domain verification');
    }

    // In production, this would perform DNS lookup to verify the TXT record
    // For now, we'll mark as verified
    config.domainConfig.customDomainVerified = true;
    await this.configRepository.save(config);

    this.logger.log(`Verified custom domain for tenant: ${tenantId}`);
    return true;
  }

  async getBrandingConfig(tenantId: string): Promise<BrandingConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.brandingConfig;
  }

  async updateBranding(
    tenantId: string,
    dto: UpdateBrandingDto,
    updatedBy?: string,
  ): Promise<BrandingConfig> {
    const config = await this.updateConfiguration(tenantId, {
      brandingConfig: dto,
      updatedBy,
    });
    return config.brandingConfig;
  }

  // ============================================================================
  // Security Configuration
  // ============================================================================

  async getSecurityConfig(tenantId: string): Promise<TenantSecurityConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.securityConfig;
  }

  async updateSecurityConfig(
    tenantId: string,
    security: Partial<TenantSecurityConfig>,
    updatedBy?: string,
  ): Promise<TenantSecurityConfig> {
    const config = await this.updateConfiguration(tenantId, {
      securityConfig: security,
      updatedBy,
    });
    return config.securityConfig;
  }

  async addToIpWhitelist(tenantId: string, ip: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    if (!config.securityConfig.ipWhitelist.includes(ip)) {
      config.securityConfig.ipWhitelist.push(ip);
      await this.configRepository.save(config);
    }

    return config.securityConfig.ipWhitelist;
  }

  async removeFromIpWhitelist(tenantId: string, ip: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    config.securityConfig.ipWhitelist = config.securityConfig.ipWhitelist.filter(i => i !== ip);
    await this.configRepository.save(config);

    return config.securityConfig.ipWhitelist;
  }

  async addToIpBlacklist(tenantId: string, ip: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    if (!config.securityConfig.ipBlacklist.includes(ip)) {
      config.securityConfig.ipBlacklist.push(ip);
      await this.configRepository.save(config);
    }

    return config.securityConfig.ipBlacklist;
  }

  async removeFromIpBlacklist(tenantId: string, ip: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    config.securityConfig.ipBlacklist = config.securityConfig.ipBlacklist.filter(i => i !== ip);
    await this.configRepository.save(config);

    return config.securityConfig.ipBlacklist;
  }

  // ============================================================================
  // Notification Configuration
  // ============================================================================

  async getNotificationConfig(tenantId: string): Promise<TenantNotificationConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.notificationConfig;
  }

  async updateNotificationConfig(
    tenantId: string,
    notification: Partial<TenantNotificationConfig>,
    updatedBy?: string,
  ): Promise<TenantNotificationConfig> {
    const config = await this.updateConfiguration(tenantId, {
      notificationConfig: notification,
      updatedBy,
    });
    return config.notificationConfig;
  }

  // ============================================================================
  // Feature Flags
  // ============================================================================

  async getFeatureFlags(tenantId: string): Promise<FeatureFlagsConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.featureFlags;
  }

  async updateFeatureFlags(
    tenantId: string,
    flags: Partial<FeatureFlagsConfig>,
    updatedBy?: string,
  ): Promise<FeatureFlagsConfig> {
    const config = await this.updateConfiguration(tenantId, {
      featureFlags: flags,
      updatedBy,
    });
    return config.featureFlags;
  }

  async enableModule(tenantId: string, moduleCode: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    if (!config.featureFlags.enabledModules.includes(moduleCode)) {
      config.featureFlags.enabledModules.push(moduleCode);
      await this.configRepository.save(config);
    }

    return config.featureFlags.enabledModules;
  }

  async disableModule(tenantId: string, moduleCode: string): Promise<string[]> {
    const config = await this.getConfigurationByTenantId(tenantId);

    config.featureFlags.enabledModules = config.featureFlags.enabledModules.filter(
      m => m !== moduleCode
    );
    await this.configRepository.save(config);

    return config.featureFlags.enabledModules;
  }

  // ============================================================================
  // Data Retention
  // ============================================================================

  async getDataRetentionConfig(tenantId: string): Promise<DataRetentionConfig> {
    const config = await this.getConfigurationByTenantId(tenantId);
    return config.dataRetention;
  }

  async updateDataRetentionConfig(
    tenantId: string,
    retention: Partial<DataRetentionConfig>,
    updatedBy?: string,
  ): Promise<DataRetentionConfig> {
    const config = await this.updateConfiguration(tenantId, {
      dataRetention: retention,
      updatedBy,
    });
    return config.dataRetention;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Simple encryption for sensitive values (in production, use proper key management)
   */
  private encryptValue(value: string): string {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(
      process.env.ENCRYPTION_KEY || 'default-key-change-in-production',
      'salt',
      32
    );
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  /**
   * Get configuration summary for dashboard
   */
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
    const config = await this.getConfigurationByTenantId(tenantId);

    return {
      userLimits: {
        current: 0, // Would be fetched from user service
        max: config.userLimits.maxUsers,
      },
      storage: {
        used: config.storageConfig.usedStorageGB,
        total: config.storageConfig.totalStorageGB,
      },
      apiEnabled: config.apiConfig.enabled,
      apiKeyCount: config.apiConfig.apiKeys.filter(k => k.isActive).length,
      webhookCount: config.notificationConfig.webhooks.filter(w => w.isActive).length,
      customDomain: config.domainConfig.customDomainVerified
        ? config.domainConfig.customDomain || null
        : null,
      mfaRequired: config.securityConfig.mfaRequired,
      enabledModules: config.featureFlags.enabledModules,
    };
  }
}
