import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  TenantConfigurationService,
  CreateTenantConfigurationDto,
  UpdateTenantConfigurationDto,
  CreateApiKeyDto,
  CreateWebhookDto,
  VerifyDomainDto,
  UpdateBrandingDto,
} from '../services/tenant-configuration.service';
import {
  UserLimitsConfig,
  StorageConfig,
  ApiConfig,
  DataRetentionConfig,
  TenantSecurityConfig,
  TenantNotificationConfig,
  FeatureFlagsConfig,
} from '../entities/tenant-configuration.entity';

@Controller('settings/tenant')
export class TenantConfigurationController {
  constructor(
    private readonly configService: TenantConfigurationService,
  ) {}

  // ============================================================================
  // Main Configuration CRUD
  // ============================================================================

  /**
   * Create configuration for a new tenant
   */
  @Post()
  async createConfiguration(@Body() dto: CreateTenantConfigurationDto) {
    return this.configService.createConfiguration(dto);
  }

  /**
   * Get configuration by tenant ID
   */
  @Get(':tenantId')
  async getConfiguration(@Param('tenantId') tenantId: string) {
    return this.configService.getConfigurationByTenantId(tenantId);
  }

  /**
   * Get or create configuration
   */
  @Get(':tenantId/ensure')
  async getOrCreateConfiguration(@Param('tenantId') tenantId: string) {
    return this.configService.getOrCreateConfiguration(tenantId);
  }

  /**
   * Update configuration
   */
  @Put(':tenantId')
  async updateConfiguration(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantConfigurationDto,
  ) {
    return this.configService.updateConfiguration(tenantId, dto);
  }

  /**
   * Delete configuration
   */
  @Delete(':tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConfiguration(@Param('tenantId') tenantId: string) {
    await this.configService.deleteConfiguration(tenantId);
  }

  /**
   * Get configuration summary for dashboard
   */
  @Get(':tenantId/summary')
  async getConfigurationSummary(@Param('tenantId') tenantId: string) {
    return this.configService.getConfigurationSummary(tenantId);
  }

  // ============================================================================
  // User Limits
  // ============================================================================

  @Get(':tenantId/user-limits')
  async getUserLimits(@Param('tenantId') tenantId: string) {
    return this.configService.getUserLimits(tenantId);
  }

  @Put(':tenantId/user-limits')
  async updateUserLimits(
    @Param('tenantId') tenantId: string,
    @Body() limits: Partial<UserLimitsConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateUserLimits(tenantId, limits, updatedBy);
  }

  // ============================================================================
  // Storage
  // ============================================================================

  @Get(':tenantId/storage')
  async getStorageConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getStorageConfig(tenantId);
  }

  @Put(':tenantId/storage')
  async updateStorageConfig(
    @Param('tenantId') tenantId: string,
    @Body() storage: Partial<StorageConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateStorageConfig(tenantId, storage, updatedBy);
  }

  @Post(':tenantId/storage/check-limit')
  async checkStorageLimit(
    @Param('tenantId') tenantId: string,
    @Body() body: { additionalSizeGB: number },
  ) {
    const allowed = await this.configService.checkStorageLimit(tenantId, body.additionalSizeGB);
    return { allowed };
  }

  // ============================================================================
  // API Configuration
  // ============================================================================

  @Get(':tenantId/api')
  async getApiConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getApiConfig(tenantId);
  }

  @Put(':tenantId/api')
  async updateApiConfig(
    @Param('tenantId') tenantId: string,
    @Body() apiConfig: Partial<ApiConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateApiConfig(tenantId, apiConfig, updatedBy);
  }

  // ============================================================================
  // API Keys
  // ============================================================================

  @Post(':tenantId/api-keys')
  async createApiKey(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.configService.createApiKey(tenantId, dto);
  }

  @Delete(':tenantId/api-keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeApiKey(
    @Param('tenantId') tenantId: string,
    @Param('keyId') keyId: string,
  ) {
    await this.configService.revokeApiKey(tenantId, keyId);
  }

  @Post(':tenantId/api-keys/validate')
  async validateApiKey(
    @Param('tenantId') tenantId: string,
    @Body() body: { apiKey: string },
  ) {
    const result = await this.configService.validateApiKey(tenantId, body.apiKey);
    return { valid: !!result, key: result };
  }

  // ============================================================================
  // Webhooks
  // ============================================================================

  @Get(':tenantId/webhooks')
  async getWebhooks(@Param('tenantId') tenantId: string) {
    return this.configService.getWebhooks(tenantId);
  }

  @Post(':tenantId/webhooks')
  async createWebhook(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.configService.createWebhook(tenantId, dto);
  }

  @Put(':tenantId/webhooks/:webhookId')
  async updateWebhook(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
    @Body() updates: Partial<CreateWebhookDto>,
  ) {
    return this.configService.updateWebhook(tenantId, webhookId, updates);
  }

  @Delete(':tenantId/webhooks/:webhookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteWebhook(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
  ) {
    await this.configService.deleteWebhook(tenantId, webhookId);
  }

  // ============================================================================
  // Domain & Branding
  // ============================================================================

  @Get(':tenantId/domain')
  async getDomainConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getDomainConfig(tenantId);
  }

  @Post(':tenantId/domain/verify')
  async initiateCustomDomainVerification(
    @Param('tenantId') tenantId: string,
    @Body() dto: VerifyDomainDto,
  ) {
    return this.configService.initiateCustomDomainVerification(tenantId, dto);
  }

  @Post(':tenantId/domain/confirm')
  async verifyCustomDomain(@Param('tenantId') tenantId: string) {
    const verified = await this.configService.verifyCustomDomain(tenantId);
    return { verified };
  }

  @Get(':tenantId/branding')
  async getBrandingConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getBrandingConfig(tenantId);
  }

  @Put(':tenantId/branding')
  async updateBranding(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateBrandingDto,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateBranding(tenantId, dto, updatedBy);
  }

  // ============================================================================
  // Security
  // ============================================================================

  @Get(':tenantId/security')
  async getSecurityConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getSecurityConfig(tenantId);
  }

  @Put(':tenantId/security')
  async updateSecurityConfig(
    @Param('tenantId') tenantId: string,
    @Body() security: Partial<TenantSecurityConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateSecurityConfig(tenantId, security, updatedBy);
  }

  @Post(':tenantId/security/ip-whitelist')
  async addToIpWhitelist(
    @Param('tenantId') tenantId: string,
    @Body() body: { ip: string },
  ) {
    return this.configService.addToIpWhitelist(tenantId, body.ip);
  }

  @Delete(':tenantId/security/ip-whitelist/:ip')
  async removeFromIpWhitelist(
    @Param('tenantId') tenantId: string,
    @Param('ip') ip: string,
  ) {
    return this.configService.removeFromIpWhitelist(tenantId, ip);
  }

  @Post(':tenantId/security/ip-blacklist')
  async addToIpBlacklist(
    @Param('tenantId') tenantId: string,
    @Body() body: { ip: string },
  ) {
    return this.configService.addToIpBlacklist(tenantId, body.ip);
  }

  @Delete(':tenantId/security/ip-blacklist/:ip')
  async removeFromIpBlacklist(
    @Param('tenantId') tenantId: string,
    @Param('ip') ip: string,
  ) {
    return this.configService.removeFromIpBlacklist(tenantId, ip);
  }

  // ============================================================================
  // Notifications
  // ============================================================================

  @Get(':tenantId/notifications')
  async getNotificationConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getNotificationConfig(tenantId);
  }

  @Put(':tenantId/notifications')
  async updateNotificationConfig(
    @Param('tenantId') tenantId: string,
    @Body() notification: Partial<TenantNotificationConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateNotificationConfig(tenantId, notification, updatedBy);
  }

  // ============================================================================
  // Feature Flags
  // ============================================================================

  @Get(':tenantId/features')
  async getFeatureFlags(@Param('tenantId') tenantId: string) {
    return this.configService.getFeatureFlags(tenantId);
  }

  @Put(':tenantId/features')
  async updateFeatureFlags(
    @Param('tenantId') tenantId: string,
    @Body() flags: Partial<FeatureFlagsConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateFeatureFlags(tenantId, flags, updatedBy);
  }

  @Post(':tenantId/features/modules/:moduleCode/enable')
  async enableModule(
    @Param('tenantId') tenantId: string,
    @Param('moduleCode') moduleCode: string,
  ) {
    return this.configService.enableModule(tenantId, moduleCode);
  }

  @Post(':tenantId/features/modules/:moduleCode/disable')
  async disableModule(
    @Param('tenantId') tenantId: string,
    @Param('moduleCode') moduleCode: string,
  ) {
    return this.configService.disableModule(tenantId, moduleCode);
  }

  // ============================================================================
  // Data Retention
  // ============================================================================

  @Get(':tenantId/data-retention')
  async getDataRetentionConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getDataRetentionConfig(tenantId);
  }

  @Put(':tenantId/data-retention')
  async updateDataRetentionConfig(
    @Param('tenantId') tenantId: string,
    @Body() retention: Partial<DataRetentionConfig>,
    @Query('updatedBy') updatedBy?: string,
  ) {
    return this.configService.updateDataRetentionConfig(tenantId, retention, updatedBy);
  }
}
