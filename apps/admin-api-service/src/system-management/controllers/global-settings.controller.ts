import {
  CreateFeatureToggleDto,
  CreateMaintenanceDto,
  CreateVersionDto,
  DeployVersionDto,
  EvaluateFeatureToggleDto,
  ExtendMaintenanceDto,
  RollbackVersionDto,
  UpdateFeatureToggleDto,
  UpdateMaintenanceDto,
} from './dto/global-settings.dto';
import { Destructive, RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, IsObject, IsDefined, MaxLength, Min, Max, ArrayMaxSize, ValidateNested } from 'class-validator';

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
import { GlobalSettingsService } from '../services/global-settings.service';

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
  @RequiresCapability('security-ops')
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
  @RequiresCapability('security-ops')
  @Put('feature-toggles/:id')
  async updateFeatureToggle(
    @Param('id') id: string,
    @Body() dto: UpdateFeatureToggleDto,
  ) {
    return this.globalSettingsService.updateFeatureToggle(id, dto);
  }

  @AuditedOperation({ resource: 'FeatureToggle', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete('feature-toggles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFeatureToggle(@Param('id') id: string) {
    await this.globalSettingsService.deleteFeatureToggle(id);
  }

  @AuditedOperation({ resource: 'GlobalSettings', action: 'EVALUATE_FEATURE_TOGGLE' })
  @RequiresCapability('security-ops')
  @Post('feature-toggles/evaluate')
  async evaluateFeatureToggle(
    @Query('key') key: string,
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() context: EvaluateFeatureToggleDto,
  ) {
    return this.globalSettingsService.evaluateFeatureToggle(key, { ...context, tenantId });
  }

  @AuditedOperation({ resource: 'FeatureToggleCache', action: 'REFRESH' })
  @RequiresCapability('security-ops')
  @Post('feature-toggles/refresh-cache')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refreshFeatureToggleCache() {
    await this.globalSettingsService.refreshCaches();
  }

  // ============================================================================
  // Maintenance Mode
  // ============================================================================

  @AuditedOperation({ resource: 'MaintenanceMode', action: 'CREATE' })
  @RequiresCapability('security-ops')
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
    @TenantParam('query', { optional: true }) tenantId?: string,
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
    @TenantParam('query', { optional: true }) tenantId?: string,
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
  @RequiresCapability('security-ops')
  @Put('maintenance/:id')
  async updateMaintenanceMode(
    @Param('id') id: string,
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: UpdateMaintenanceDto,
  ) {
    return this.globalSettingsService.updateMaintenanceMode(id, {
      ...dto,
      tenantId,
      scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
    });
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'START' })
  @RequiresCapability('security-ops')
  @Post('maintenance/:id/start')
  async startMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.startMaintenance(id);
  }

  @AuditedOperation({ resource: 'GlobalSettings', action: 'END_MAINTENANCE' })
  @RequiresCapability('security-ops')
  @Post('maintenance/:id/end')
  async endMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.endMaintenance(id);
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'CANCEL' })
  @RequiresCapability('security-ops')
  @Post('maintenance/:id/cancel')
  async cancelMaintenance(@Param('id') id: string) {
    return this.globalSettingsService.cancelMaintenance(id);
  }

  @AuditedOperation({ resource: 'Maintenance', action: 'EXTEND' })
  @RequiresCapability('security-ops')
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
  @RequiresCapability('security-ops')
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
  @RequiresCapability('security-ops')
  @Post('versions/:id/deploy')
  async deployVersion(@Param('id') id: string, @Body() dto: DeployVersionDto) {
    return this.globalSettingsService.deployVersion(id, dto.deployedBy);
  }

  @AuditedOperation({ resource: 'Version', action: 'ROLLBACK' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Post('versions/:id/rollback')
  async rollbackVersion(
    @Param('id') id: string,
    @Body() dto: RollbackVersionDto,
  ) {
    return this.globalSettingsService.rollbackVersion(id, dto.reason, dto.rolledBackBy);
  }

  // ============================================================================
  // Provisioning Configuration
  // ============================================================================

  /** Env-backed read consumed by sensor-service's installer-script generator.
   *  SEC-M19: not @Public() — protected by the global APP_GUARD (PlatformAdminGuard). */
  @Get('provisioning-config')
  getProvisioningConfig(): ReturnType<GlobalSettingsService['getProvisioningConfig']> {
    return this.globalSettingsService.getProvisioningConfig();
  }

  // ============================================================================
  // System Status
  // ============================================================================

  @Get('status')
  async getSystemStatus() {
    return this.globalSettingsService.getSystemStatus();
  }
}
