import { Destructive, RequiresCapability } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { getAuthUserId } from '../../shared/authenticated-request';

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
  UpdateUserLimitsDto,
  UpdateStorageConfigDto,
  CheckStorageLimitDto,
  UpdateApiConfigDto,
  ValidateApiKeyDto,
  UpdateWebhookDto,
  UpdateTenantSecurityDto,
  IpAddressDto,
  UpdateNotificationConfigDto,
  UpdateFeatureFlagsDto,
  UpdateDataRetentionDto,
} from '../dto/tenant-configuration.dto';

@ApiTags('Settings')
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
  @AuditedOperation({ resource: 'Configuration', action: 'CREATE' })
  @RequiresCapability('security-ops')
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
  @AuditedOperation({ resource: 'Configuration', action: 'UPDATE' })
  @RequiresCapability('security-ops')
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
  @AuditedOperation({ resource: 'Configuration', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConfiguration(@Param('tenantId') tenantId: string) {
    // configService is a synchronous legacy adapter (deleteConfiguration
    // throws GoneException synchronously); awaiting a non-thenable is an
    // await-thenable error. The handler stays async to preserve the Nest
    // route signature; the synchronous throw still propagates correctly.
    this.configService.deleteConfiguration(tenantId);
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

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'UserLimits', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/user-limits')
  async updateUserLimits(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateUserLimitsDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateUserLimits(tenantId, dto, userId);
  }

  // ============================================================================
  // Storage
  // ============================================================================

  @Get(':tenantId/storage')
  async getStorageConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getStorageConfig(tenantId);
  }

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'StorageConfig', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/storage')
  async updateStorageConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateStorageConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateStorageConfig(tenantId, dto, userId);
  }

  @AuditedOperation({ resource: 'TenantConfiguration', action: 'CHECK_STORAGE_LIMIT' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/storage/check-limit')
  async checkStorageLimit(
    @Param('tenantId') tenantId: string,
    @Body() dto: CheckStorageLimitDto,
  ) {
    const allowed = this.configService.checkStorageLimit(tenantId, dto.additionalSizeGB);
    return { allowed };
  }

  // ============================================================================
  // API Configuration
  // ============================================================================

  @Get(':tenantId/api')
  async getApiConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getApiConfig(tenantId);
  }

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'ApiConfig', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/api')
  async updateApiConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateApiConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateApiConfig(tenantId, dto, userId);
  }

  // ============================================================================
  // API Keys
  // ============================================================================

  @AuditedOperation({ resource: 'ApiKey', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/api-keys')
  async createApiKey(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.configService.createApiKey(tenantId, dto);
  }

  @AuditedOperation({ resource: 'ApiKey', action: 'REVOKE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':tenantId/api-keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeApiKey(
    @Param('tenantId') tenantId: string,
    @Param('keyId') keyId: string,
  ) {
    this.configService.revokeApiKey(tenantId, keyId);
  }

  @AuditedOperation({ resource: 'ApiKey', action: 'VALIDATE' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/api-keys/validate')
  async validateApiKey(
    @Param('tenantId') tenantId: string,
    @Body() dto: ValidateApiKeyDto,
  ) {
    const result = this.configService.validateApiKey(tenantId, dto.apiKey);
    return { valid: !!result, key: result };
  }

  // ============================================================================
  // Webhooks
  // ============================================================================

  @Get(':tenantId/webhooks')
  async getWebhooks(@Param('tenantId') tenantId: string) {
    return this.configService.getWebhooks(tenantId);
  }

  @AuditedOperation({ resource: 'Webhook', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/webhooks')
  async createWebhook(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.configService.createWebhook(tenantId, dto);
  }

  @AuditedOperation({ resource: 'Webhook', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/webhooks/:webhookId')
  async updateWebhook(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.configService.updateWebhook(tenantId, webhookId, dto);
  }

  @AuditedOperation({ resource: 'Webhook', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':tenantId/webhooks/:webhookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteWebhook(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
  ) {
    this.configService.deleteWebhook(tenantId, webhookId);
  }

  // ============================================================================
  // Domain & Branding
  // ============================================================================

  @Get(':tenantId/domain')
  async getDomainConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getDomainConfig(tenantId);
  }

  @AuditedOperation({ resource: 'CustomDomainVerification', action: 'INITIATE' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/domain/verify')
  async initiateCustomDomainVerification(
    @Param('tenantId') tenantId: string,
    @Body() dto: VerifyDomainDto,
  ) {
    return this.configService.initiateCustomDomainVerification(tenantId, dto);
  }

  @AuditedOperation({ resource: 'CustomDomain', action: 'VERIFY' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/domain/confirm')
  async verifyCustomDomain(@Param('tenantId') tenantId: string) {
    const verified = this.configService.verifyCustomDomain(tenantId);
    return { verified };
  }

  @Get(':tenantId/branding')
  async getBrandingConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getBrandingConfig(tenantId);
  }

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'Branding', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/branding')
  async updateBranding(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateBrandingDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateBranding(tenantId, dto, userId);
  }

  // ============================================================================
  // Security
  // ============================================================================

  @Get(':tenantId/security')
  async getSecurityConfig(@Param('tenantId') tenantId: string) {
    return this.configService.getSecurityConfig(tenantId);
  }

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'SecurityConfig', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/security')
  async updateSecurityConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantSecurityDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateSecurityConfig(tenantId, dto, userId);
  }

  @AuditedOperation({ resource: 'ToIpWhitelist', action: 'ADD' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/security/ip-whitelist')
  async addToIpWhitelist(
    @Param('tenantId') tenantId: string,
    @Body() dto: IpAddressDto,
  ) {
    return this.configService.addToIpWhitelist(tenantId, dto.ip);
  }

  @AuditedOperation({ resource: 'FromIpWhitelist', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':tenantId/security/ip-whitelist/:ip')
  async removeFromIpWhitelist(
    @Param('tenantId') tenantId: string,
    @Param('ip') ip: string,
  ) {
    return this.configService.removeFromIpWhitelist(tenantId, ip);
  }

  @AuditedOperation({ resource: 'ToIpBlacklist', action: 'ADD' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/security/ip-blacklist')
  async addToIpBlacklist(
    @Param('tenantId') tenantId: string,
    @Body() dto: IpAddressDto,
  ) {
    return this.configService.addToIpBlacklist(tenantId, dto.ip);
  }

  @AuditedOperation({ resource: 'FromIpBlacklist', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
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

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'NotificationConfig', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/notifications')
  async updateNotificationConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateNotificationConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateNotificationConfig(tenantId, dto, userId);
  }

  // ============================================================================
  // Feature Flags
  // ============================================================================

  @Get(':tenantId/features')
  async getFeatureFlags(@Param('tenantId') tenantId: string) {
    return this.configService.getFeatureFlags(tenantId);
  }

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'FeatureFlags', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/features')
  async updateFeatureFlags(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateFeatureFlagsDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateFeatureFlags(tenantId, dto, userId);
  }

  @AuditedOperation({ resource: 'Module', action: 'ENABLE' })
  @RequiresCapability('security-ops')
  @Post(':tenantId/features/modules/:moduleCode/enable')
  async enableModule(
    @Param('tenantId') tenantId: string,
    @Param('moduleCode') moduleCode: string,
  ) {
    return this.configService.enableModule(tenantId, moduleCode);
  }

  @AuditedOperation({ resource: 'Module', action: 'DISABLE' })
  @RequiresCapability('security-ops')
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

  // Fix: C6 -- JWT-based identity
  @AuditedOperation({ resource: 'DataRetentionConfig', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':tenantId/data-retention')
  async updateDataRetentionConfig(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateDataRetentionDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.configService.updateDataRetentionConfig(tenantId, dto, userId);
  }
}
