import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  Max,
  Min,
  IsOptional,
} from 'class-validator';
import { Request } from 'express';

import { getAuthUserId } from '../shared/authenticated-request';

import {
  BulkUpdateSettingsDto,
  ImportSettingsDto,
  SetMaintenanceModeDto,
  UpdateBillingConfigDto,
  UpdateEmailConfigDto,
  UpdateSystemSettingDto,
} from './dto/settings.dto';
import { SettingCategory } from './entities/system-setting.entity';
import { EmailSenderService } from './services/email-sender.service';
import { SystemSettingService } from './services/system-setting.service';

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
  passwordRequireUppercase?: boolean;

  @IsOptional() @IsBoolean()
  passwordRequireNumbers?: boolean;

  @IsOptional() @IsBoolean()
  passwordRequireSymbols?: boolean;

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

class TestEmailConfigDto {
  @IsEmail()
  to!: string;
}

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SystemSettingService,
    private readonly emailSenderService: EmailSenderService,
  ) {}

  // ============================================================================
  // System Settings
  // ============================================================================

  /**
   * Get all system settings grouped by category
   */
  @Get()
  getAllSettings(
    @Query('includePrivate') includePrivate?: string,
  ): ReturnType<SystemSettingService['getAllSettings']> {
    return this.settingsService.getAllSettings(includePrivate === 'true');
  }

  /**
   * Get settings by category
   */
  @Get('category/:category')
  getSettingsByCategory(
    @Param('category') category: SettingCategory,
    @Query('includePrivate') includePrivate?: string,
  ): ReturnType<SystemSettingService['getSettingsByCategory']> {
    return this.settingsService.getSettingsByCategory(
      category,
      includePrivate === 'true',
    );
  }

  /**
   * Get specific setting by key
   */
  @Get('key/:key')
  getSettingByKey(
    @Param('key') key: string,
  ): ReturnType<SystemSettingService['getSettingByKey']> {
    return this.settingsService.getSettingByKey(key);
  }

  /**
   * Update a setting
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Put('key/:key')
  updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSystemSettingDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateSetting(key, { ...dto, updatedBy: userId });
  }

  /**
   * Reset setting to default
   * Fix: MEDIUM-003 -- audit trail with updatedBy from JWT
   */
  @ThrottleSensitive()
  @Post('key/:key/reset')
  resetToDefault(@Param('key') key: string, @Req() req: Request): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.resetToDefault(key, userId);
  }

  /**
   * Bulk update settings
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Put('bulk')
  bulkUpdate(
    @Body() dto: BulkUpdateSettingsDto,
    @Req() req: Request,
  ): never {
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
  getEmailConfig(): ReturnType<SystemSettingService['getEmailConfig']> {
    return this.settingsService.getEmailConfig();
  }

  /**
   * Update email configuration
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Put('config/email')
  updateEmailConfig(
    @Body() dto: UpdateEmailConfigDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateEmailConfig(dto, userId);
  }

  @ThrottleSensitive()
  @Post('config/email/test')
  async testEmailConfig(@Body() dto: TestEmailConfigDto): Promise<unknown> {
    const connection = await this.emailSenderService.testConnection();
    if (!connection.success) {
      return connection;
    }

    let sendResult;
    try {
      sendResult = await this.emailSenderService.sendEmail(
        dto.to,
        'Aquaculture Platform SMTP Test',
        '<p>SMTP configuration test completed successfully.</p>',
        'SMTP configuration test completed successfully.',
        { required: true, maxRetries: 1 },
      );
    } catch (error) {
      throw new BadRequestException(`SMTP test email failed: ${(error as Error).message}`);
    }

    return {
      success: sendResult.success,
      messageId: sendResult.messageId,
      attempts: sendResult.attempts,
      error: sendResult.error,
    };
  }

  /**
   * Get security configuration
   */
  @Get('config/security')
  getSecurityConfig(): ReturnType<SystemSettingService['getSecurityConfig']> {
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
  updateSecurityConfig(
    @Body() body: UpdateSecurityConfigDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateSecurityConfig(body, userId);
  }

  /**
   * Get rate limit configuration
   */
  @Get('config/rate-limits')
  getRateLimitConfig(): ReturnType<SystemSettingService['getRateLimitConfig']> {
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
  updateRateLimitConfig(
    @Body() body: UpdateRateLimitConfigDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateRateLimitConfig(body, userId);
  }

  /**
   * Get maintenance status
   */
  @Get('config/maintenance')
  getMaintenanceStatus(): ReturnType<SystemSettingService['getMaintenanceStatus']> {
    return this.settingsService.getMaintenanceStatus();
  }

  /**
   * Toggle maintenance mode
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Put('config/maintenance')
  setMaintenanceMode(
    @Body() dto: SetMaintenanceModeDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.setMaintenanceMode(
      dto.enabled,
      dto.message,
      dto.allowedIps,
      userId,
    );
  }

  /**
   * Get billing configuration
   */
  @Get('config/billing')
  getBillingConfig(): ReturnType<SystemSettingService['getBillingConfig']> {
    return this.settingsService.getBillingConfig();
  }

  /**
   * Update billing configuration
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Put('config/billing')
  updateBillingConfig(
    @Body() dto: UpdateBillingConfigDto,
    @Req() req: Request,
  ): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('User not authenticated');
    return this.settingsService.updateBillingConfig(dto, userId);
  }

  // ============================================================================
  // Feature Flags
  // ============================================================================

  /**
   * Check if a feature is enabled
   */
  @Get('features/:featureKey')
  isFeatureEnabled(
    @Param('featureKey') featureKey: string,
    @Query('default') defaultValue?: string,
  ): { featureKey: string; enabled: boolean } {
    const enabled = this.settingsService.isFeatureEnabled(
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
  exportSettings(): ReturnType<SystemSettingService['exportSettings']> {
    return this.settingsService.exportSettings();
  }

  /**
   * Import settings
   * Fix: C6 -- JWT-based identity
   */
  @ThrottleSensitive()
  @Post('import')
  importSettings(
    @Body() dto: ImportSettingsDto,
    @Req() req: Request,
  ): never {
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
  getSystemInfo(): {
    platform: { name: string; version: string };
    security: ReturnType<SystemSettingService['getSecurityConfig']>;
    rateLimits: ReturnType<SystemSettingService['getRateLimitConfig']>;
    maintenance: ReturnType<SystemSettingService['getMaintenanceStatus']>;
  } {
    const security = this.settingsService.getSecurityConfig();
    const rateLimits = this.settingsService.getRateLimitConfig();
    const maintenance = this.settingsService.getMaintenanceStatus();

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
