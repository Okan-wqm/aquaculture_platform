import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import {
  FeatureToggle,
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureCondition,
} from '../entities/feature-toggle.entity';
import {
  MaintenanceMode,
  MaintenanceScope,
  MaintenanceStatus,
  MaintenanceType,
} from '../entities/maintenance-mode.entity';
import {
  SystemVersion,
  ReleaseType,
  ReleaseStatus,
  ChangelogEntry,
} from '../entities/system-version.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface FeatureToggleEvaluation {
  key: string;
  enabled: boolean;
  variant?: string;
  value?: unknown;
  reason: string;
}

export interface MaintenanceCheck {
  isInMaintenance: boolean;
  maintenanceInfo?: {
    id: string;
    title: string;
    message: string;
    estimatedEnd?: Date;
    allowReadOnly: boolean;
  };
}

export interface SystemHealthStatus {
  version: string;
  uptime: number;
  environment: string;
  maintenanceMode: boolean;
  featureToggles: number;
}

// ============================================================================
// Feature Toggle Service
// ============================================================================

@Injectable()
export class GlobalSettingsService implements OnModuleInit {
  private readonly logger = new Logger(GlobalSettingsService.name);
  private featureToggleCache: Map<string, FeatureToggle> = new Map();
  private lastCacheRefresh: Date = new Date(0);
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(
    @InjectRepository(FeatureToggle)
    private readonly featureToggleRepo: Repository<FeatureToggle>,
    @InjectRepository(MaintenanceMode)
    private readonly maintenanceModeRepo: Repository<MaintenanceMode>,
    @InjectRepository(SystemVersion)
    private readonly systemVersionRepo: Repository<SystemVersion>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCaches();
  }

  // ============================================================================
  // Feature Toggle Management
  // ============================================================================

  async createFeatureToggle(data: {
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
    createdBy?: string;
  }): Promise<FeatureToggle> {
    const existing = await this.featureToggleRepo.findOne({ where: { key: data.key } });
    if (existing) {
      throw new BadRequestException(`Feature toggle with key '${data.key}' already exists`);
    }

    const toggle = this.featureToggleRepo.create({
      ...data,
      scope: data.scope || FeatureToggleScope.GLOBAL,
      status: data.status || FeatureToggleStatus.DISABLED,
      rolloutPercentage: data.rolloutPercentage || 0,
      requiresRestart: data.requiresRestart || false,
      isExperimental: data.isExperimental || false,
    });

    const saved = await this.featureToggleRepo.save(toggle);
    this.featureToggleCache.set(saved.key, saved);

    this.logger.log(`Created feature toggle: ${saved.key}`);
    return saved;
  }

  async updateFeatureToggle(
    id: string,
    data: Partial<FeatureToggle> & { updatedBy?: string },
  ): Promise<FeatureToggle> {
    const toggle = await this.featureToggleRepo.findOne({ where: { id } });
    if (!toggle) {
      throw new NotFoundException(`Feature toggle not found: ${id}`);
    }

    Object.assign(toggle, data);
    const saved = await this.featureToggleRepo.save(toggle);
    this.featureToggleCache.set(saved.key, saved);

    this.logger.log(`Updated feature toggle: ${saved.key}`);
    return saved;
  }

  async deleteFeatureToggle(id: string): Promise<void> {
    const toggle = await this.featureToggleRepo.findOne({ where: { id } });
    if (!toggle) {
      throw new NotFoundException(`Feature toggle not found: ${id}`);
    }

    await this.featureToggleRepo.remove(toggle);
    this.featureToggleCache.delete(toggle.key);

    this.logger.log(`Deleted feature toggle: ${toggle.key}`);
  }

  async getFeatureToggle(id: string): Promise<FeatureToggle> {
    const toggle = await this.featureToggleRepo.findOne({ where: { id } });
    if (!toggle) {
      throw new NotFoundException(`Feature toggle not found: ${id}`);
    }
    return toggle;
  }

  async getFeatureToggleByKey(key: string): Promise<FeatureToggle | null> {
    await this.ensureCacheFresh();
    return this.featureToggleCache.get(key) || null;
  }

  async queryFeatureToggles(params: {
    scope?: FeatureToggleScope;
    status?: FeatureToggleStatus;
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: FeatureToggle[]; total: number }> {
    const query = this.featureToggleRepo.createQueryBuilder('toggle');

    if (params.scope) {
      query.andWhere('toggle.scope = :scope', { scope: params.scope });
    }
    if (params.status) {
      query.andWhere('toggle.status = :status', { status: params.status });
    }
    if (params.category) {
      query.andWhere('toggle.category = :category', { category: params.category });
    }
    if (params.search) {
      query.andWhere(
        '(toggle.key ILIKE :search OR toggle.name ILIKE :search OR toggle.description ILIKE :search)',
        { search: `%${params.search}%` },
      );
    }

    const page = params.page || 1;
    const limit = params.limit || 50;

    query.orderBy('toggle.category', 'ASC').addOrderBy('toggle.key', 'ASC');
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  async evaluateFeatureToggle(
    key: string,
    context: {
      tenantId?: string;
      userId?: string;
      userRole?: string;
      planType?: string;
      region?: string;
      custom?: Record<string, string>;
    },
  ): Promise<FeatureToggleEvaluation> {
    const toggle = await this.getFeatureToggleByKey(key);

    if (!toggle) {
      return { key, enabled: false, reason: 'Feature toggle not found' };
    }

    // Check deprecation
    if (toggle.deprecatedAt && toggle.deprecatedAt <= new Date()) {
      return { key, enabled: false, reason: 'Feature is deprecated', value: toggle.defaultValue };
    }

    // Check status
    if (toggle.status === FeatureToggleStatus.DISABLED) {
      return { key, enabled: false, reason: 'Feature is disabled', value: toggle.defaultValue };
    }

    if (toggle.status === FeatureToggleStatus.ENABLED) {
      return this.evaluateWithVariants(toggle, context, 'Feature is enabled');
    }

    // Check scheduled rollout
    if (toggle.status === FeatureToggleStatus.SCHEDULED && toggle.rolloutSchedule) {
      const now = new Date();
      if (now < toggle.rolloutSchedule.startDate) {
        return { key, enabled: false, reason: 'Scheduled rollout not started' };
      }
      if (toggle.rolloutSchedule.endDate && now > toggle.rolloutSchedule.endDate) {
        return this.evaluateWithVariants(toggle, context, 'Scheduled rollout completed');
      }
    }

    // Check tenant-specific settings
    if (context.tenantId) {
      if (toggle.disabledTenants?.includes(context.tenantId)) {
        return { key, enabled: false, reason: 'Disabled for this tenant' };
      }
      if (toggle.enabledTenants?.includes(context.tenantId)) {
        return this.evaluateWithVariants(toggle, context, 'Enabled for this tenant');
      }
    }

    // Evaluate conditions
    if (toggle.conditions && toggle.conditions.length > 0) {
      const conditionMet = this.evaluateConditions(toggle.conditions, context);
      if (!conditionMet) {
        return { key, enabled: false, reason: 'Conditions not met' };
      }
    }

    // Percentage rollout
    if (toggle.status === FeatureToggleStatus.PERCENTAGE_ROLLOUT) {
      const bucket = this.calculateBucket(key, context.tenantId || context.userId || 'anonymous');
      if (bucket > toggle.rolloutPercentage) {
        return { key, enabled: false, reason: 'Not in rollout percentage' };
      }
      return this.evaluateWithVariants(toggle, context, 'In rollout percentage');
    }

    return this.evaluateWithVariants(toggle, context, 'Default evaluation');
  }

  private evaluateWithVariants(
    toggle: FeatureToggle,
    context: { tenantId?: string; userId?: string },
    reason: string,
  ): FeatureToggleEvaluation {
    if (!toggle.variants || toggle.variants.length === 0) {
      return { key: toggle.key, enabled: true, reason, value: toggle.defaultValue };
    }

    const bucket = this.calculateBucket(
      toggle.key + '_variant',
      context.tenantId || context.userId || 'anonymous',
    );

    let cumulative = 0;
    for (const variant of toggle.variants) {
      cumulative += variant.weight;
      if (bucket <= cumulative) {
        return {
          key: toggle.key,
          enabled: true,
          variant: variant.key,
          value: variant.value,
          reason: `${reason} - variant: ${variant.key}`,
        };
      }
    }

    return { key: toggle.key, enabled: true, reason, value: toggle.defaultValue };
  }

  private evaluateConditions(
    conditions: FeatureCondition[],
    context: Record<string, unknown>,
  ): boolean {
    return conditions.every((condition) => {
      const contextValue = this.getContextValue(condition.type, context);
      if (contextValue === undefined) return false;

      switch (condition.operator) {
        case 'equals':
          return contextValue === condition.value;
        case 'not_equals':
          return contextValue !== condition.value;
        case 'contains':
          return this.conditionValueToString(contextValue).includes(
            this.conditionValueToString(condition.value),
          );
        case 'in':
          return (
            Array.isArray(condition.value) && (condition.value as unknown[]).includes(contextValue)
          );
        case 'not_in':
          return (
            Array.isArray(condition.value) && !(condition.value as unknown[]).includes(contextValue)
          );
        case 'regex':
          return new RegExp(this.conditionValueToString(condition.value)).test(
            this.conditionValueToString(contextValue),
          );
        default:
          return false;
      }
    });
  }

  private conditionValueToString(value: unknown): string {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return value.toString();
    }
    return '';
  }

  private getContextValue(type: string, context: Record<string, unknown>): unknown {
    const mapping: Record<string, string> = {
      tenant_id: 'tenantId',
      user_role: 'userRole',
      plan_type: 'planType',
      region: 'region',
    };
    const key = mapping[type] || type;
    return context[key] || (context['custom'] as Record<string, unknown>)?.[type];
  }

  private calculateBucket(key: string, identifier: string): number {
    /** SEC-L02: Use SHA-256 instead of MD5. MD5 has known collision vulnerabilities
     *  and is prohibited by NIST SP 800-131A for any new application. */
    const hash = crypto.createHash('sha256').update(`${key}:${identifier}`).digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return (num % 100) + 1;
  }

  // ============================================================================
  // Maintenance Mode Management
  // ============================================================================

  async createMaintenanceMode(data: {
    title: string;
    description: string;
    scope?: MaintenanceScope;
    type?: MaintenanceType;
    tenantId?: string;
    affectedTenants?: string[];
    affectedServices?: Array<{
      name: string;
      status: 'unavailable' | 'degraded' | 'read_only';
      message?: string;
    }>;
    scheduledStart: Date;
    scheduledEnd?: Date;
    estimatedDurationMinutes?: number;
    userMessage?: string;
    allowReadOnlyAccess?: boolean;
    bypassForSuperAdmins?: boolean;
    whitelistedIPs?: string[];
    createdBy?: string;
  }): Promise<MaintenanceMode> {
    const maintenance = this.maintenanceModeRepo.create({
      ...data,
      scope: data.scope || MaintenanceScope.GLOBAL,
      type: data.type || MaintenanceType.SCHEDULED,
      status: MaintenanceStatus.SCHEDULED,
      estimatedDurationMinutes: data.estimatedDurationMinutes || 60,
      allowReadOnlyAccess: data.allowReadOnlyAccess || false,
      bypassForSuperAdmins: data.bypassForSuperAdmins ?? true,
    });

    const saved = await this.maintenanceModeRepo.save(maintenance);
    this.logger.log(`Created maintenance mode: ${saved.title}`);
    return saved;
  }

  async updateMaintenanceMode(
    id: string,
    data: Partial<MaintenanceMode> & { updatedBy?: string },
  ): Promise<MaintenanceMode> {
    const maintenance = await this.maintenanceModeRepo.findOne({ where: { id } });
    if (!maintenance) {
      throw new NotFoundException(`Maintenance mode not found: ${id}`);
    }

    Object.assign(maintenance, data);
    const saved = await this.maintenanceModeRepo.save(maintenance);

    this.logger.log(`Updated maintenance mode: ${saved.title}`);
    return saved;
  }

  async startMaintenance(id: string, updatedBy?: string): Promise<MaintenanceMode> {
    return this.updateMaintenanceMode(id, {
      status: MaintenanceStatus.IN_PROGRESS,
      actualStart: new Date(),
      updatedBy,
    });
  }

  async endMaintenance(id: string, updatedBy?: string): Promise<MaintenanceMode> {
    return this.updateMaintenanceMode(id, {
      status: MaintenanceStatus.COMPLETED,
      actualEnd: new Date(),
      updatedBy,
    });
  }

  async cancelMaintenance(id: string, updatedBy?: string): Promise<MaintenanceMode> {
    return this.updateMaintenanceMode(id, {
      status: MaintenanceStatus.CANCELLED,
      updatedBy,
    });
  }

  async extendMaintenance(
    id: string,
    additionalMinutes: number,
    updatedBy?: string,
  ): Promise<MaintenanceMode> {
    const maintenance = await this.maintenanceModeRepo.findOne({ where: { id } });
    if (!maintenance) {
      throw new NotFoundException(`Maintenance mode not found: ${id}`);
    }

    const newEnd = maintenance.scheduledEnd
      ? new Date(maintenance.scheduledEnd.getTime() + additionalMinutes * 60000)
      : new Date(Date.now() + additionalMinutes * 60000);

    return this.updateMaintenanceMode(id, {
      status: MaintenanceStatus.EXTENDED,
      scheduledEnd: newEnd,
      estimatedDurationMinutes: maintenance.estimatedDurationMinutes + additionalMinutes,
      updatedBy,
    });
  }

  async checkMaintenanceMode(
    tenantId?: string,
    ipAddress?: string,
    userId?: string,
    isSuperAdmin?: boolean,
  ): Promise<MaintenanceCheck> {
    const now = new Date();

    const query = this.maintenanceModeRepo
      .createQueryBuilder('m')
      .where('m.status = :status', { status: MaintenanceStatus.IN_PROGRESS })
      .orWhere('m.status = :scheduled AND m.scheduledStart <= :now', {
        scheduled: MaintenanceStatus.SCHEDULED,
        now,
      });

    const activeMaintenance = await query.getMany();

    for (const maintenance of activeMaintenance) {
      // Check if bypassed for super admins
      if (isSuperAdmin && maintenance.bypassForSuperAdmins) {
        continue;
      }

      // Check whitelisted IPs
      if (ipAddress && maintenance.whitelistedIPs?.includes(ipAddress)) {
        continue;
      }

      // Check whitelisted users
      if (userId && maintenance.whitelistedUsers?.includes(userId)) {
        continue;
      }

      // Check scope
      if (maintenance.scope === MaintenanceScope.GLOBAL) {
        return this.buildMaintenanceResponse(maintenance);
      }

      if (maintenance.scope === MaintenanceScope.TENANT) {
        if (maintenance.tenantId === tenantId) {
          return this.buildMaintenanceResponse(maintenance);
        }
        if (maintenance.affectedTenants?.includes(tenantId || '')) {
          return this.buildMaintenanceResponse(maintenance);
        }
      }
    }

    return { isInMaintenance: false };
  }

  private buildMaintenanceResponse(maintenance: MaintenanceMode): MaintenanceCheck {
    return {
      isInMaintenance: true,
      maintenanceInfo: {
        id: maintenance.id,
        title: maintenance.title,
        message: maintenance.userMessage || maintenance.description,
        estimatedEnd: maintenance.scheduledEnd || undefined,
        allowReadOnly: maintenance.allowReadOnlyAccess,
      },
    };
  }

  async getMaintenanceMode(id: string): Promise<MaintenanceMode> {
    const maintenance = await this.maintenanceModeRepo.findOne({ where: { id } });
    if (!maintenance) {
      throw new NotFoundException(`Maintenance mode not found: ${id}`);
    }
    return maintenance;
  }

  async queryMaintenanceModes(params: {
    scope?: MaintenanceScope;
    status?: MaintenanceStatus;
    type?: MaintenanceType;
    tenantId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ items: MaintenanceMode[]; total: number }> {
    const query = this.maintenanceModeRepo.createQueryBuilder('m');

    if (params.scope) {
      query.andWhere('m.scope = :scope', { scope: params.scope });
    }
    if (params.status) {
      query.andWhere('m.status = :status', { status: params.status });
    }
    if (params.type) {
      query.andWhere('m.type = :type', { type: params.type });
    }
    if (params.tenantId) {
      query.andWhere('(m.tenantId = :tenantId OR m.affectedTenants @> :tenantArray)', {
        tenantId: params.tenantId,
        tenantArray: JSON.stringify([params.tenantId]),
      });
    }
    if (params.startDate) {
      query.andWhere('m.scheduledStart >= :startDate', { startDate: params.startDate });
    }
    if (params.endDate) {
      query.andWhere('m.scheduledStart <= :endDate', { endDate: params.endDate });
    }

    const page = params.page || 1;
    const limit = params.limit || 20;

    query.orderBy('m.scheduledStart', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Version Management
  // ============================================================================

  async createSystemVersion(data: {
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
    createdBy?: string;
  }): Promise<SystemVersion> {
    const [major, minor, patch] = data.version.split('.').map((n) => parseInt(n, 10) || 0);

    const existing = await this.systemVersionRepo.findOne({ where: { version: data.version } });
    if (existing) {
      throw new BadRequestException(`Version ${data.version} already exists`);
    }

    const currentVersion = await this.systemVersionRepo.findOne({
      where: { isCurrentVersion: true },
    });

    const systemVersion = this.systemVersionRepo.create({
      ...data,
      majorVersion: major,
      minorVersion: minor,
      patchVersion: patch,
      status: ReleaseStatus.DRAFT,
      previousVersion: currentVersion?.version,
    });

    const saved = await this.systemVersionRepo.save(systemVersion);
    this.logger.log(`Created system version: ${saved.version}`);
    return saved;
  }

  async deployVersion(id: string, deployedBy: string): Promise<SystemVersion> {
    const version = await this.systemVersionRepo.findOne({ where: { id } });
    if (!version) {
      throw new NotFoundException(`Version not found: ${id}`);
    }

    // Mark previous current version as not current
    await this.systemVersionRepo.update({ isCurrentVersion: true }, { isCurrentVersion: false });

    // Update this version
    version.status = ReleaseStatus.DEPLOYED;
    version.deployedAt = new Date();
    version.deployedBy = deployedBy;
    version.isCurrentVersion = true;

    const saved = await this.systemVersionRepo.save(version);
    this.logger.log(`Deployed version: ${saved.version}`);
    return saved;
  }

  async rollbackVersion(id: string, reason: string, rolledBackBy: string): Promise<SystemVersion> {
    const version = await this.systemVersionRepo.findOne({ where: { id } });
    if (!version) {
      throw new NotFoundException(`Version not found: ${id}`);
    }

    if (!version.previousVersion) {
      throw new BadRequestException('No previous version to rollback to');
    }

    const previousVersion = await this.systemVersionRepo.findOne({
      where: { version: version.previousVersion },
    });
    if (!previousVersion) {
      throw new BadRequestException(`Previous version ${version.previousVersion} not found`);
    }

    // Mark current as rolled back
    version.status = ReleaseStatus.ROLLED_BACK;
    version.isCurrentVersion = false;
    version.rollbackInfo = {
      rolledBackAt: new Date(),
      rolledBackBy,
      reason,
      targetVersion: previousVersion.version,
    };
    await this.systemVersionRepo.save(version);

    // Restore previous version as current
    previousVersion.isCurrentVersion = true;
    previousVersion.status = ReleaseStatus.DEPLOYED;
    await this.systemVersionRepo.save(previousVersion);

    this.logger.warn(`Rolled back from ${version.version} to ${previousVersion.version}`);
    return version;
  }

  async getCurrentVersion(): Promise<SystemVersion | null> {
    return this.systemVersionRepo.findOne({ where: { isCurrentVersion: true } });
  }

  async queryVersions(params: {
    releaseType?: ReleaseType;
    status?: ReleaseStatus;
    page?: number;
    limit?: number;
  }): Promise<{ items: SystemVersion[]; total: number }> {
    const query = this.systemVersionRepo.createQueryBuilder('v');

    if (params.releaseType) {
      query.andWhere('v.releaseType = :releaseType', { releaseType: params.releaseType });
    }
    if (params.status) {
      query.andWhere('v.status = :status', { status: params.status });
    }

    const page = params.page || 1;
    const limit = params.limit || 20;

    query
      .orderBy('v.majorVersion', 'DESC')
      .addOrderBy('v.minorVersion', 'DESC')
      .addOrderBy('v.patchVersion', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  private async ensureCacheFresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCacheRefresh.getTime() > this.CACHE_TTL_MS) {
      await this.refreshCaches();
    }
  }

  async refreshCaches(): Promise<void> {
    const toggles = await this.featureToggleRepo.find();

    this.featureToggleCache.clear();
    toggles.forEach((t) => this.featureToggleCache.set(t.key, t));

    this.lastCacheRefresh = new Date();
    this.logger.debug(`Refreshed caches: ${toggles.length} toggles`);
  }

  // ============================================================================
  // Scheduled Tasks
  // ============================================================================

  @Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledMaintenanceStart(): Promise<void> {
    const now = new Date();
    const upcoming = await this.maintenanceModeRepo.find({
      where: {
        status: MaintenanceStatus.SCHEDULED,
        scheduledStart: LessThanOrEqual(now),
      },
    });

    for (const maintenance of upcoming) {
      await this.startMaintenance(maintenance.id, 'system');
      this.logger.log(`Auto-started scheduled maintenance: ${maintenance.title}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleScheduledFeatureRollouts(): Promise<void> {
    const now = new Date();
    const scheduled = await this.featureToggleRepo.find({
      where: { status: FeatureToggleStatus.SCHEDULED },
    });

    for (const toggle of scheduled) {
      if (toggle.rolloutSchedule && toggle.rolloutSchedule.startDate <= now) {
        // Calculate current percentage based on schedule
        if (toggle.rolloutSchedule.incrementPerDay && toggle.rolloutSchedule.targetPercentage) {
          const daysSinceStart = Math.floor(
            (now.getTime() - toggle.rolloutSchedule.startDate.getTime()) / (24 * 60 * 60 * 1000),
          );
          const newPercentage = Math.min(
            toggle.rolloutSchedule.percentage +
              daysSinceStart * toggle.rolloutSchedule.incrementPerDay,
            toggle.rolloutSchedule.targetPercentage,
          );

          if (newPercentage !== toggle.rolloutPercentage) {
            toggle.rolloutPercentage = newPercentage;
            toggle.status = FeatureToggleStatus.PERCENTAGE_ROLLOUT;
            await this.featureToggleRepo.save(toggle);
            this.logger.log(`Updated rollout for ${toggle.key}: ${newPercentage}%`);
          }

          if (newPercentage >= toggle.rolloutSchedule.targetPercentage) {
            toggle.status = FeatureToggleStatus.ENABLED;
            await this.featureToggleRepo.save(toggle);
            this.logger.log(`Completed rollout for ${toggle.key}`);
          }
        }
      }
    }
  }

  // ============================================================================
  // System Status
  // ============================================================================

  async getSystemStatus(): Promise<SystemHealthStatus> {
    const [currentVersion, maintenanceCheck, toggleCount] = await Promise.all([
      this.getCurrentVersion(),
      this.checkMaintenanceMode(),
      this.featureToggleRepo.count(),
    ]);

    return {
      version: currentVersion?.version || 'unknown',
      uptime: process.uptime(),
      environment: process.env['NODE_ENV'] || 'development',
      maintenanceMode: maintenanceCheck.isInMaintenance,
      featureToggles: toggleCount,
    };
  }
}
