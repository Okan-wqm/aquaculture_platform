import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { Request } from 'express';

// Fix: MEDIUM-002 -- rate-limit sensitive PUT endpoints
import { ThrottleSensitive } from '@aquaculture/backend-common';
import { getAuthUserId } from '../shared/authenticated-request';
import { SettingCategory } from './entities/system-setting.entity';
import { SystemSettingService, UpdateSystemSettingDto } from './services/system-setting.service';
import {
  BulkUpdateSettingsDto,
  UpdateEmailConfigDto,
  SetMaintenanceModeDto,
  UpdateBillingConfigDto,
  ImportSettingsDto,
} from './dto/settings.dto';

// ============================================================================
// DTOs with Validation (Fix: MEDIUM-001)
// ============================================================================

class UpdateSecurityConfigDto {
  @IsOptional() @IsInt() @Min(5) @Max(1440)
  sessionTimeoutMinutes?: number;

  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxLoginAttempts?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1440)
  lockoutDurationMinutes?: number;

  @IsOptional() @IsInt() @Min(8) @Max(128)
  passwordMinLength?: number;

  @IsOptional() @IsBoolean()
  mfaEnabled?: boolean;

  @IsOptional() @IsBoolean()
  enforceHttps?: boolean;
}

class UpdateRateLimitConfigDto {
  @IsOptional() @IsInt() @Min(10) @Max(10000)
  globalRpm?: number;

  @IsOptional() @IsInt() @Min(5) @Max(5000)
  perUserRpm?: number;

  @IsOptional() @IsInt() @Min(10) @Max(10000)
  perTenantRpm?: number;

  @IsOptional() @IsInt() @Min(5) @Max(5000)
  apiKeyRpm?: number;
}

@ApiTags('Settings')
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
   * Fix: C6 -- JWT-based identity
   */
  @Put('key/:key')
  async updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSystemSettingDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateSetting(key, { ...dto, updatedBy: userId });
  }

  /**
   * Reset setting to default
   * Fix: MEDIUM-003 -- audit trail with updatedBy from JWT
   */
  @Post('key/:key/reset')
  async resetToDefault(@Param('key') key: string, @Req() req: Request) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.resetToDefault(key, userId);
  }

  /**
   * Bulk update settings
   * Fix: C6 -- JWT-based identity
   */
  @Put('bulk')
  async bulkUpdate(
    @Body() dto: BulkUpdateSettingsDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.bulkUpdate(dto.updates, userId);
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
   * Fix: C6 -- JWT-based identity
   */
  @Put('config/email')
  async updateEmailConfig(
    @Body() dto: UpdateEmailConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    await this.settingsService.updateEmailConfig(dto, userId);
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
   * Update security configuration
   * Fix: H20 -- PUT security endpoint for SystemSettingsPage
   * Fix: MEDIUM-001 -- proper DTO with class-validator
   * Fix: MEDIUM-002 -- rate-limit sensitive endpoint
   */
  @ThrottleSensitive()
  @Put('config/security')
  async updateSecurityConfig(
    @Body() body: UpdateSecurityConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    await this.settingsService.updateSecurityConfig(body, userId);
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
   * Update rate limit configuration
   * Fix: H20 -- PUT rate-limits endpoint for SystemSettingsPage
   * Fix: MEDIUM-001 -- proper DTO with class-validator
   * Fix: MEDIUM-002 -- rate-limit sensitive endpoint
   */
  @ThrottleSensitive()
  @Put('config/rate-limits')
  async updateRateLimitConfig(
    @Body() body: UpdateRateLimitConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    await this.settingsService.updateRateLimitConfig(body, userId);
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
   * Fix: C6 -- JWT-based identity
   */
  @Put('config/maintenance')
  async setMaintenanceMode(
    @Body() dto: SetMaintenanceModeDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    await this.settingsService.setMaintenanceMode(
      dto.enabled,
      dto.message,
      dto.allowedIps,
      userId,
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
   * Fix: C6 -- JWT-based identity
   */
  @Put('config/billing')
  async updateBillingConfig(
    @Body() dto: UpdateBillingConfigDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    await this.settingsService.updateBillingConfig(dto, userId);
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
   * Fix: C6 -- JWT-based identity
   */
  @Post('import')
  async importSettings(
    @Body() dto: ImportSettingsDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.importSettings(dto.data, userId);
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
      },
      security,
      rateLimits,
      maintenance,
    };
  }
}
