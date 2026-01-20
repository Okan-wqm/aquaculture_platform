import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { GlobalSettingsService } from '../services/global-settings.service';
import {
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureCondition,
} from '../entities/feature-toggle.entity';
import {
  MaintenanceScope,
  MaintenanceStatus,
  MaintenanceType,
} from '../entities/maintenance-mode.entity';
import { ReleaseType, ReleaseStatus, ChangelogEntry } from '../entities/system-version.entity';
import { ConfigCategory, ConfigValueType } from '../entities/global-config.entity';

// ============================================================================
// DTOs
// ============================================================================

class CreateFeatureToggleDto {
  key: string;
  name: string;
  description?: string;
  scope?: FeatureToggleScope;
  status?: FeatureToggleStatus;
  category?: string;
  conditions?: FeatureCondition[];
  rolloutPercentage?: number;
  defaultValue?: unknown;
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;
  requiresRestart?: boolean;
  isExperimental?: boolean;
}

class UpdateFeatureToggleDto {
  name?: string;
  description?: string;
  status?: FeatureToggleStatus;
  category?: string;
  conditions?: FeatureCondition[];
  rolloutPercentage?: number;
  enabledTenants?: string[];
  disabledTenants?: string[];
  defaultValue?: unknown;
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;
  deprecatedAt?: Date;
  deprecationMessage?: string;
}

class EvaluateFeatureToggleDto {
  tenantId?: string;
  userId?: string;
  userRole?: string;
  planType?: string;
  region?: string;
  custom?: Record<string, string>;
}

class CreateMaintenanceDto {
  title: string;
  description: string;
  scope?: MaintenanceScope;
  type?: MaintenanceType;
  tenantId?: string;
  affectedTenants?: string[];
  affectedServices?: Array<{ name: string; status: 'unavailable' | 'degraded' | 'read_only'; message?: string }>;
  scheduledStart: Date;
  scheduledEnd?: Date;
  estimatedDurationMinutes?: number;
  userMessage?: string;
  allowReadOnlyAccess?: boolean;
  bypassForSuperAdmins?: boolean;
  whitelistedIPs?: string[];
}

class CreateVersionDto {
  version: string;
  releaseType: ReleaseType;
  title: string;
  summary?: string;
  changelog?: ChangelogEntry[];
  breakingChanges?: string[];
  deprecations?: string[];
  newFeatures?: string[];
  releaseNotes?: string;
  upgradeGuide?: string;
}

class CreateConfigDto {
  key: string;
  name: string;
  description?: string;
  category?: ConfigCategory;
  valueType?: ConfigValueType;
  value: unknown;
  defaultValue?: unknown;
  validation?: {
    required?: boolean;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    allowedValues?: unknown[];
  };
  isSecret?: boolean;
  isReadOnly?: boolean;
  requiresRestart?: boolean;
  helpText?: string;
}

class UpdateConfigDto {
  value: unknown;
  reason?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('system/settings')
export class GlobalSettingsController {
  constructor(private readonly globalSettingsService: GlobalSettingsService) {}

  // ============================================================================
  // Feature Toggles
  // ============================================================================

  @Post('feature-toggles')
  async createFeatureToggle(@Body() dto: CreateFeatureToggleDto) {
    return this.globalSettingsService.createFeatureToggle(dto);
  }

  @Get('feature-toggles')
  async queryFeatureToggles(
    @Query('scope') scope?: FeatureToggleScope,
    @Query('status') status?: FeatureToggleStatus,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.globalSettingsService.queryFeatureToggles({
      scope,
      status,
      category,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('feature-toggles/:id')
  async getFeatureToggle(@Param('id') id: string) {
    return this.globalSettingsService.getFeatureToggle(id);
  }

  @Put('feature-toggles/:id')
  async updateFeatureToggle(
    @Param('id') id: string,
    @Body() dto: UpdateFeatureToggleDto,
  ) {
    return this.globalSettingsService.updateFeatureToggle(id, dto);
  }

  @Delete('feature-toggles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFeatureToggle(@Param('id') id: string) {
    await this.globalSettingsService.deleteFeatureToggle(id);
  }

  @Post('feature-toggles/evaluate')
  async evaluateFeatureToggle(
    @Query('key') key: string,
    @Body() context: EvaluateFeatureToggleDto,
  ) {
    return this.globalSettingsService.evaluateFeatureToggle(key, context);
  }

  @Post('feature-toggles/refresh-cache')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refreshFeatureToggleCache() {
    await this.globalSettingsService.refreshCaches();
  }

  // ============================================================================
  // Maintenance Mode
  // ============================================================================

  @Post('maintenance')
  async createMaintenanceMode(@Body() dto: CreateMaintenanceDto) {
    return this.globalSettingsService.createMaintenanceMode({
      ...dto,
      scheduledStart: new Date(dto.scheduledStart),
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
    });
  }

  @Get('maintenance')
  async queryMaintenanceModes(
    @Query('scope') scope?: MaintenanceScope,
    @Query('status') status?: MaintenanceStatus,
    @Query('type') type?: MaintenanceType,
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.globalSettingsService.queryMaintenanceModes({
      scope,
      status,
      type,
      tenantId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('maintenance/check')
  async checkMaintenanceMode(
    @Query('tenantId') tenantId?: string,
    @Query('ipAddress') ipAddress?: string,
    @Query('userId') userId?: string,
    @Query('isSuperAdmin') isSuperAdmin?: string,
  ) {
    return this.globalSettingsService.checkMaintenanceMode(
      tenantId,
      ipAddress,
      userId,
      isSuperAdmin === 'true',
    );
  }

  @Get('maintenance/:id')
  async getMaintenanceMode(@Param('id') id: string) {
    return this.globalSettingsService.getMaintenanceMode(id);
  }

  @Put('maintenance/:id')
  async updateMaintenanceMode(
    @Param('id') id: string,
    @Body() dto: Partial<CreateMaintenanceDto>,
  ) {
    return this.globalSettingsService.updateMaintenanceMode(id, {
      ...dto,
      scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
    });
  }

  @Post('maintenance/:id/start')
  async startMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.startMaintenance(id);
  }

  @Post('maintenance/:id/end')
  async endMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.endMaintenance(id);
  }

  @Post('maintenance/:id/cancel')
  async cancelMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.cancelMaintenance(id);
  }

  @Post('maintenance/:id/extend')
  async extendMaintenance(
    @Param('id') id: string,
    @Body() dto: { additionalMinutes: number },
  ) {
    return this.globalSettingsService.extendMaintenance(id, dto.additionalMinutes);
  }

  // ============================================================================
  // Version Management
  // ============================================================================

  @Post('versions')
  async createVersion(@Body() dto: CreateVersionDto) {
    return this.globalSettingsService.createSystemVersion(dto);
  }

  @Get('versions')
  async queryVersions(
    @Query('releaseType') releaseType?: ReleaseType,
    @Query('status') status?: ReleaseStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.globalSettingsService.queryVersions({
      releaseType,
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('versions/current')
  async getCurrentVersion() {
    return this.globalSettingsService.getCurrentVersion();
  }

  @Post('versions/:id/deploy')
  async deployVersion(@Param('id') id: string, @Body() dto: { deployedBy: string }) {
    return this.globalSettingsService.deployVersion(id, dto.deployedBy);
  }

  @Post('versions/:id/rollback')
  async rollbackVersion(
    @Param('id') id: string,
    @Body() dto: { reason: string; rolledBackBy: string },
  ) {
    return this.globalSettingsService.rollbackVersion(id, dto.reason, dto.rolledBackBy);
  }

  // ============================================================================
  // Global Configuration
  // ============================================================================

  @Post('configs')
  async createConfig(@Body() dto: CreateConfigDto) {
    return this.globalSettingsService.createConfig(dto);
  }

  @Get('configs')
  async queryConfigs(
    @Query('category') category?: ConfigCategory,
    @Query('isSecret') isSecret?: string,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.globalSettingsService.queryConfigs({
      category,
      isSecret: isSecret !== undefined ? isSecret === 'true' : undefined,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('configs/:id')
  async getConfig(@Param('id') id: string) {
    return this.globalSettingsService.getConfigEntity(id);
  }

  @Put('configs/:id')
  async updateConfig(
    @Param('id') id: string,
    @Body() dto: UpdateConfigDto,
  ) {
    return this.globalSettingsService.updateConfig(id, dto.value, 'admin', dto.reason);
  }

  @Post('configs/bulk-update')
  async bulkUpdateConfigs(
    @Body() dto: { updates: Array<{ key: string; value: unknown }> },
  ) {
    return this.globalSettingsService.bulkUpdateConfigs(dto.updates, 'admin');
  }

  // ============================================================================
  // System Status
  // ============================================================================

  @Get('status')
  async getSystemStatus() {
    return this.globalSettingsService.getSystemStatus();
  }
}
