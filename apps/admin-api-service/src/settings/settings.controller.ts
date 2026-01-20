import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { SystemSettingService, UpdateSystemSettingDto } from './services/system-setting.service';
import { SettingCategory } from './entities/system-setting.entity';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SystemSettingService) {}

  // ============================================================================
  // System Settings
  // ============================================================================

  /**
   * Get all system settings grouped by category
   */
  @Get()
  async getAllSettings(@Query('includePrivate') includePrivate?: string) {
    return this.settingsService.getAllSettings(includePrivate === 'true');
  }

  /**
   * Get settings by category
   */
  @Get('category/:category')
  async getSettingsByCategory(
    @Param('category') category: SettingCategory,
    @Query('includePrivate') includePrivate?: string,
  ) {
    return this.settingsService.getSettingsByCategory(
      category,
      includePrivate === 'true',
    );
  }

  /**
   * Get specific setting by key
   */
  @Get('key/:key')
  async getSettingByKey(@Param('key') key: string) {
    return this.settingsService.getSettingByKey(key);
  }

  /**
   * Update a setting
   */
  @Put('key/:key')
  async updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSystemSettingDto,
  ) {
    return this.settingsService.updateSetting(key, dto);
  }

  /**
   * Reset setting to default
   */
  @Post('key/:key/reset')
  async resetToDefault(@Param('key') key: string) {
    return this.settingsService.resetToDefault(key);
  }

  /**
   * Bulk update settings
   */
  @Put('bulk')
  async bulkUpdate(
    @Body() body: { updates: { key: string; value: string }[]; updatedBy?: string },
  ) {
    return this.settingsService.bulkUpdate(body.updates, body.updatedBy);
  }

  // ============================================================================
  // Configuration Endpoints
  // ============================================================================

  /**
   * Get email configuration
   */
  @Get('config/email')
  async getEmailConfig() {
    return this.settingsService.getEmailConfig();
  }

  /**
   * Update email configuration
   */
  @Put('config/email')
  async updateEmailConfig(
    @Body()
    body: {
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
      smtpUsername?: string;
      smtpPassword?: string;
      fromAddress?: string;
      fromName?: string;
      updatedBy?: string;
    },
  ) {
    const { updatedBy, ...config } = body;
    await this.settingsService.updateEmailConfig(config, updatedBy);
    return this.settingsService.getEmailConfig();
  }

  /**
   * Get security configuration
   */
  @Get('config/security')
  async getSecurityConfig() {
    return this.settingsService.getSecurityConfig();
  }

  /**
   * Get rate limit configuration
   */
  @Get('config/rate-limits')
  async getRateLimitConfig() {
    return this.settingsService.getRateLimitConfig();
  }

  /**
   * Get maintenance status
   */
  @Get('config/maintenance')
  async getMaintenanceStatus() {
    return this.settingsService.getMaintenanceStatus();
  }

  /**
   * Toggle maintenance mode
   */
  @Put('config/maintenance')
  async setMaintenanceMode(
    @Body()
    body: {
      enabled: boolean;
      message?: string;
      allowedIps?: string[];
      updatedBy?: string;
    },
  ) {
    await this.settingsService.setMaintenanceMode(
      body.enabled,
      body.message,
      body.allowedIps,
      body.updatedBy,
    );
    return this.settingsService.getMaintenanceStatus();
  }

  /**
   * Get billing configuration
   */
  @Get('config/billing')
  async getBillingConfig() {
    return this.settingsService.getBillingConfig();
  }

  /**
   * Update billing configuration
   */
  @Put('config/billing')
  async updateBillingConfig(
    @Body()
    body: {
      stripeEnabled?: boolean;
      defaultCurrency?: string;
      taxRate?: number;
      invoiceDueDays?: number;
      updatedBy?: string;
    },
  ) {
    const { updatedBy, ...config } = body;
    await this.settingsService.updateBillingConfig(config, updatedBy);
    return this.settingsService.getBillingConfig();
  }

  // ============================================================================
  // Feature Flags
  // ============================================================================

  /**
   * Check if a feature is enabled
   */
  @Get('features/:featureKey')
  async isFeatureEnabled(
    @Param('featureKey') featureKey: string,
    @Query('default') defaultValue?: string,
  ) {
    const enabled = await this.settingsService.isFeatureEnabled(
      featureKey,
      defaultValue === 'true',
    );
    return { featureKey, enabled };
  }

  // ============================================================================
  // Import/Export
  // ============================================================================

  /**
   * Export all settings
   */
  @Get('export')
  async exportSettings() {
    return this.settingsService.exportSettings();
  }

  /**
   * Import settings
   */
  @Post('import')
  async importSettings(
    @Body() body: { data: Record<string, unknown>; updatedBy?: string },
  ) {
    return this.settingsService.importSettings(body.data, body.updatedBy);
  }

  // ============================================================================
  // System Info (Legacy support)
  // ============================================================================

  /**
   * Get system information
   */
  @Get('system/info')
  async getSystemInfo() {
    const security = await this.settingsService.getSecurityConfig();
    const rateLimits = await this.settingsService.getRateLimitConfig();
    const maintenance = await this.settingsService.getMaintenanceStatus();

    return {
      platform: {
        name: 'Aquaculture Platform',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
      },
      security,
      rateLimits,
      maintenance,
    };
  }
}
