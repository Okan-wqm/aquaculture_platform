import { Destructive } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, IsObject, IsDefined, MaxLength, Min, Max, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Request } from 'express';

import { getAuthUser } from '../../shared/authenticated-request';
import {
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureCondition,
} from '../entities/feature-toggle.entity';
import { ConfigCategory, ConfigValueType } from '../entities/global-config.entity';
import {
  MaintenanceScope,
  MaintenanceStatus,
  MaintenanceType,
} from '../entities/maintenance-mode.entity';
import { ReleaseType, ReleaseStatus, ChangelogEntry } from '../entities/system-version.entity';
import { GlobalSettingsService } from '../services/global-settings.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateFeatureToggleDto {
  @IsString()
  key!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  scope?: FeatureToggleScope;

  @IsOptional()
  @IsString()
  status?: FeatureToggleStatus;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  conditions?: FeatureCondition[];

  @IsOptional()
  @IsNumber()
  rolloutPercentage?: number;

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsArray()
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;

  @IsOptional()
  @IsBoolean()
  requiresRestart?: boolean;

  @IsOptional()
  @IsBoolean()
  isExperimental?: boolean;
}

class UpdateFeatureToggleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  status?: FeatureToggleStatus;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  conditions?: FeatureCondition[];

  @IsOptional()
  @IsNumber()
  rolloutPercentage?: number;

  @IsOptional()
  @IsArray()
  enabledTenants?: string[];

  @IsOptional()
  @IsArray()
  disabledTenants?: string[];

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsArray()
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;

  @IsOptional()
  deprecatedAt?: Date;

  @IsOptional()
  @IsString()
  deprecationMessage?: string;
}

class EvaluateFeatureToggleDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  userRole?: string;

  @IsOptional()
  @IsString()
  planType?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsObject()
  custom?: Record<string, string>;
}

class CreateMaintenanceDto {
  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  scope?: MaintenanceScope;

  @IsOptional()
  @IsString()
  type?: MaintenanceType;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsArray()
  affectedTenants?: string[];

  @IsOptional()
  @IsArray()
  affectedServices?: Array<{ name: string; status: 'unavailable' | 'degraded' | 'read_only'; message?: string }>;

  @IsDefined()
  scheduledStart!: Date;

  @IsOptional()
  scheduledEnd?: Date;

  @IsOptional()
  @IsNumber()
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsString()
  userMessage?: string;

  @IsOptional()
  @IsBoolean()
  allowReadOnlyAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  bypassForSuperAdmins?: boolean;

  @IsOptional()
  @IsArray()
  whitelistedIPs?: string[];
}

class CreateVersionDto {
  @IsString()
  version!: string;

  @IsString()
  releaseType!: ReleaseType;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  changelog?: ChangelogEntry[];

  @IsOptional()
  @IsArray()
  breakingChanges?: string[];

  @IsOptional()
  @IsArray()
  deprecations?: string[];

  @IsOptional()
  @IsArray()
  newFeatures?: string[];

  @IsOptional()
  @IsString()
  releaseNotes?: string;

  @IsOptional()
  @IsString()
  upgradeGuide?: string;
}

class CreateConfigDto {
  @IsString()
  key!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: ConfigCategory;

  @IsOptional()
  @IsString()
  valueType?: ConfigValueType;

  @IsDefined()
  value!: unknown;

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsObject()
  validation?: {
    required?: boolean;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    allowedValues?: unknown[];
  };

  @IsOptional()
  @IsBoolean()
  isSecret?: boolean;

  @IsOptional()
  @IsBoolean()
  isReadOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresRestart?: boolean;

  @IsOptional()
  @IsString()
  helpText?: string;
}

class UpdateConfigDto {
  @IsDefined()
  value!: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class UpdateMaintenanceDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  scope?: MaintenanceScope;

  @IsOptional()
  @IsString()
  type?: MaintenanceType;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedTenants?: string[];

  @IsOptional()
  @IsArray()
  affectedServices?: Array<{ name: string; status: 'unavailable' | 'degraded' | 'read_only'; message?: string }>;

  @IsOptional()
  scheduledStart?: Date;

  @IsOptional()
  scheduledEnd?: Date;

  @IsOptional()
  @IsNumber()
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  userMessage?: string;

  @IsOptional()
  @IsBoolean()
  allowReadOnlyAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  bypassForSuperAdmins?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  whitelistedIPs?: string[];
}

class ExtendMaintenanceDto {
  @IsNumber()
  @Min(1)
  @Max(1440)
  additionalMinutes!: number;
}

class DeployVersionDto {
  @IsString()
  @MaxLength(255)
  deployedBy!: string;
}

class RollbackVersionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MaxLength(255)
  rolledBackBy!: string;
}

class BulkConfigUpdateItem {
  @IsString()
  @MaxLength(255)
  key!: string;

  @IsDefined()
  value!: unknown;
}

class BulkUpdateConfigsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkConfigUpdateItem)
  updates!: BulkConfigUpdateItem[];
}

// UpdateProvisioningConfig uses runtime validation in the handler
// since it's a dynamic key-value Record<string, string>

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Settings')
@Controller('system/settings')
export class GlobalSettingsController {
  constructor(private readonly globalSettingsService: GlobalSettingsService) {}

  // ============================================================================
  // Feature Toggles
  // ============================================================================

  @AuditedOperation({ resource: 'FeatureToggle', action: 'CREATE' })
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

  @AuditedOperation({ resource: 'FeatureToggle', action: 'UPDATE' })
  @Put('feature-toggles/:id')
  async updateFeatureToggle(
    @Param('id') id: string,
    @Body() dto: UpdateFeatureToggleDto,
  ) {
    return this.globalSettingsService.updateFeatureToggle(id, dto);
  }

  @AuditedOperation({ resource: 'FeatureToggle', action: 'DELETE' })
  @Destructive()
  @Delete('feature-toggles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFeatureToggle(@Param('id') id: string) {
    await this.globalSettingsService.deleteFeatureToggle(id);
  }

  @AuditedOperation({ resource: 'GlobalSettings', action: 'EVALUATE_FEATURE_TOGGLE' })
  @Post('feature-toggles/evaluate')
  async evaluateFeatureToggle(
    @Query('key') key: string,
    @Body() context: EvaluateFeatureToggleDto,
  ) {
    return this.globalSettingsService.evaluateFeatureToggle(key, context);
  }

  @AuditedOperation({ resource: 'FeatureToggleCache', action: 'REFRESH' })
  @Post('feature-toggles/refresh-cache')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refreshFeatureToggleCache() {
    await this.globalSettingsService.refreshCaches();
  }

  // ============================================================================
  // Maintenance Mode
  // ============================================================================

  @AuditedOperation({ resource: 'MaintenanceMode', action: 'CREATE' })
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

  @AuditedOperation({ resource: 'MaintenanceMode', action: 'UPDATE' })
  @Put('maintenance/:id')
  async updateMaintenanceMode(
    @Param('id') id: string,
    @Body() dto: UpdateMaintenanceDto,
  ) {
    return this.globalSettingsService.updateMaintenanceMode(id, {
      ...dto,
      scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
    });
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'START' })
  @Post('maintenance/:id/start')
  async startMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.startMaintenance(id);
  }

  @AuditedOperation({ resource: 'GlobalSettings', action: 'END_MAINTENANCE' })
  @Post('maintenance/:id/end')
  async endMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.endMaintenance(id);
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'CANCEL' })
  @Post('maintenance/:id/cancel')
  async cancelMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.cancelMaintenance(id);
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'EXTEND' })
  @Post('maintenance/:id/extend')
  async extendMaintenance(
    @Param('id') id: string,
    @Body() dto: ExtendMaintenanceDto,
  ) {
    return this.globalSettingsService.extendMaintenance(id, dto.additionalMinutes);
  }

  // ============================================================================
  // Version Management
  // ============================================================================

  @AuditedOperation({ resource: 'Version', action: 'CREATE' })
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

  @AuditedOperation({ resource: 'GlobalSettings', action: 'DEPLOY_VERSION' })
  @Post('versions/:id/deploy')
  async deployVersion(@Param('id') id: string, @Body() dto: DeployVersionDto) {
    return this.globalSettingsService.deployVersion(id, dto.deployedBy);
  }

  @AuditedOperation({ resource: 'Version', action: 'ROLLBACK' })
  @Destructive()
  @Post('versions/:id/rollback')
  async rollbackVersion(
    @Param('id') id: string,
    @Body() dto: RollbackVersionDto,
  ) {
    return this.globalSettingsService.rollbackVersion(id, dto.reason, dto.rolledBackBy);
  }

  // ============================================================================
  // Global Configuration
  // ============================================================================

  @AuditedOperation({ resource: 'Config', action: 'CREATE' })
  @Post('configs')
  createConfig(@Body() dto: CreateConfigDto): never {
    return this.globalSettingsService.createConfig(dto);
  }

  @Get('configs')
  queryConfigs(
    @Query('category') category?: ConfigCategory,
    @Query('isSecret') isSecret?: string,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): ReturnType<GlobalSettingsService['queryConfigs']> {
    return this.globalSettingsService.queryConfigs({
      category,
      isSecret: isSecret !== undefined ? isSecret === 'true' : undefined,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('configs/:id')
  getConfig(@Param('id') id: string): never {
    return this.globalSettingsService.getConfigEntity(id);
  }

  @AuditedOperation({ resource: 'Config', action: 'UPDATE' })
  @Put('configs/:id')
  updateConfig(
    @Param('id') id: string,
    @Body() dto: UpdateConfigDto,
  ): never {
    return this.globalSettingsService.updateConfig(id, dto.value, 'admin', dto.reason);
  }

  @AuditedOperation({ resource: 'UpdateConfigs', action: 'BULK' })
  @Post('configs/bulk-update')
  bulkUpdateConfigs(
    @Body() dto: BulkUpdateConfigsDto,
  ): never {
    return this.globalSettingsService.bulkUpdateConfigs(dto.updates, 'admin');
  }

  // ============================================================================
  // Provisioning Configuration
  // ============================================================================

  /** SEC-M19: Removed @Public() — this endpoint exposes platform configuration
   *  and must be protected by the global APP_GUARD (PlatformAdminGuard). */
  @Get('provisioning-config')
  getProvisioningConfig(): ReturnType<GlobalSettingsService['getProvisioningConfig']> {
    return this.globalSettingsService.getProvisioningConfig();
  }

  @AuditedOperation({ resource: 'ProvisioningConfig', action: 'UPDATE' })
  @Put('provisioning-config')
  updateProvisioningConfig(
    @Body() body: Record<string, string>,
    @Req() req: Request,
  ): never {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Invalid configuration payload');
    }
    const user = getAuthUser(req);
    const updatedBy = user?.email || user?.id || 'admin';
    return this.globalSettingsService.updateProvisioningConfig(body, updatedBy);
  }

  // ============================================================================
  // System Status
  // ============================================================================

  @Get('status')
  async getSystemStatus() {
    return this.globalSettingsService.getSystemStatus();
  }
}
