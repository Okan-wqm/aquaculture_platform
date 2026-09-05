import { RequiresCapability } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

import { SettingCategory } from './entities/system-setting.entity';
import { EmailSenderService } from './services/email-sender.service';
import { SystemSettingService } from './services/system-setting.service';

/**
 * System settings are READ here and owned by config-service (ORPHAN-HIGH-373):
 * every write went through a retired store and answered 410 Gone, so the
 * write routes are gone with it (ADMIN-HIGH-011). Only the env-backed reads,
 * the live SMTP test-send and the system-info summary remain.
 */
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

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'EmailConfig', action: 'TEST' })
  @RequiresCapability('security-ops')
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
   * Get rate limit configuration
   */
  @Get('config/rate-limits')
  getRateLimitConfig(): ReturnType<SystemSettingService['getRateLimitConfig']> {
    return this.settingsService.getRateLimitConfig();
  }

  /**
   * Get maintenance status
   */
  @Get('config/maintenance')
  getMaintenanceStatus(): ReturnType<SystemSettingService['getMaintenanceStatus']> {
    return this.settingsService.getMaintenanceStatus();
  }

  /**
   * Get billing configuration
   */
  @Get('config/billing')
  getBillingConfig(): ReturnType<SystemSettingService['getBillingConfig']> {
    return this.settingsService.getBillingConfig();
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
