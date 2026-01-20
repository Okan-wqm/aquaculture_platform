import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual, MoreThanOrEqual, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';

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
import {
  GlobalConfig,
  ConfigCategory,
  ConfigValueType,
  ConfigHistory,
} from '../entities/global-config.entity';

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
  activeConfigs: number;
}

// ============================================================================
// Feature Toggle Service
// ============================================================================

@Injectable()
export class GlobalSettingsService {
  private readonly logger = new Logger(GlobalSettingsService.name);
  private featureToggleCache: Map<string, FeatureToggle> = new Map();
  private configCache: Map<string, GlobalConfig> = new Map();
  private lastCacheRefresh: Date = new Date(0);
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(
    @InjectRepository(FeatureToggle)
    private readonly featureToggleRepo: Repository<FeatureToggle>,
    @InjectRepository(MaintenanceMode)
    private readonly maintenanceModeRepo: Repository<MaintenanceMode>,
    @InjectRepository(SystemVersion)
    private readonly systemVersionRepo: Repository<SystemVersion>,
    @InjectRepository(GlobalConfig)
    private readonly globalConfigRepo: Repository<GlobalConfig>,
  ) {
    this.refreshCaches();
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
          return String(contextValue).includes(String(condition.value));
        case 'in':
          return Array.isArray(condition.value) && (condition.value as unknown[]).includes(contextValue);
        case 'not_in':
          return Array.isArray(condition.value) && !(condition.value as unknown[]).includes(contextValue);
        case 'regex':
          return new RegExp(String(condition.value)).test(String(contextValue));
        default:
          return false;
      }
    });
  }

  private getContextValue(type: string, context: Record<string, unknown>): unknown {
    const mapping: Record<string, string> = {
      tenant_id: 'tenantId',
      user_role: 'userRole',
      plan_type: 'planType',
      region: 'region',
    };
    const key = mapping[type] || type;
    return context[key] || (context.custom as Record<string, unknown>)?.[type];
  }

  private calculateBucket(key: string, identifier: string): number {
    const hash = crypto.createHash('md5').update(`${key}:${identifier}`).digest('hex');
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
    affectedServices?: Array<{ name: string; status: 'unavailable' | 'degraded' | 'read_only'; message?: string }>;
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
      .orWhere(
        'm.status = :scheduled AND m.scheduledStart <= :now',
        { scheduled: MaintenanceStatus.SCHEDULED, now },
      );

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
      query.andWhere(
        '(m.tenantId = :tenantId OR m.affectedTenants @> :tenantArray)',
        { tenantId: params.tenantId, tenantArray: JSON.stringify([params.tenantId]) },
      );
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
    await this.systemVersionRepo.update(
      { isCurrentVersion: true },
      { isCurrentVersion: false },
    );

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

    query.orderBy('v.majorVersion', 'DESC')
      .addOrderBy('v.minorVersion', 'DESC')
      .addOrderBy('v.patchVersion', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Global Configuration Management
  // ============================================================================

  async createConfig(data: {
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
    createdBy?: string;
  }): Promise<GlobalConfig> {
    const existing = await this.globalConfigRepo.findOne({ where: { key: data.key } });
    if (existing) {
      throw new BadRequestException(`Configuration with key '${data.key}' already exists`);
    }

    // Validate the value
    if (data.validation) {
      this.validateConfigValue(data.value, data.validation);
    }

    const config = this.globalConfigRepo.create({
      ...data,
      category: data.category || ConfigCategory.SYSTEM,
      valueType: data.valueType || ConfigValueType.STRING,
      isSecret: data.isSecret || false,
      isReadOnly: data.isReadOnly || false,
      requiresRestart: data.requiresRestart || false,
      history: [],
      lastModifiedBy: data.createdBy,
    });

    const saved = await this.globalConfigRepo.save(config);
    this.configCache.set(saved.key, saved);

    this.logger.log(`Created config: ${saved.key}`);
    return this.maskSecretConfig(saved);
  }

  async updateConfig(
    id: string,
    value: unknown,
    updatedBy: string,
    reason?: string,
  ): Promise<GlobalConfig> {
    const config = await this.globalConfigRepo.findOne({ where: { id } });
    if (!config) {
      throw new NotFoundException(`Configuration not found: ${id}`);
    }

    if (config.isReadOnly) {
      throw new BadRequestException(`Configuration '${config.key}' is read-only`);
    }

    if (config.validation) {
      this.validateConfigValue(value, config.validation);
    }

    // Add to history
    const historyEntry: ConfigHistory = {
      previousValue: config.value,
      newValue: value,
      changedAt: new Date(),
      changedBy: updatedBy,
      reason,
    };

    const history = config.history || [];
    history.push(historyEntry);

    // Keep only last N entries
    while (history.length > config.maxHistoryEntries) {
      history.shift();
    }

    config.value = value;
    config.history = history;
    config.lastModifiedBy = updatedBy;

    const saved = await this.globalConfigRepo.save(config);
    this.configCache.set(saved.key, saved);

    this.logger.log(`Updated config: ${saved.key}`);
    return this.maskSecretConfig(saved);
  }

  async getConfig(key: string): Promise<unknown> {
    await this.ensureCacheFresh();
    const config = this.configCache.get(key);
    return config?.value;
  }

  async getConfigEntity(id: string): Promise<GlobalConfig> {
    const config = await this.globalConfigRepo.findOne({ where: { id } });
    if (!config) {
      throw new NotFoundException(`Configuration not found: ${id}`);
    }
    return this.maskSecretConfig(config);
  }

  async queryConfigs(params: {
    category?: ConfigCategory;
    isSecret?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: GlobalConfig[]; total: number }> {
    const query = this.globalConfigRepo.createQueryBuilder('c');

    if (params.category) {
      query.andWhere('c.category = :category', { category: params.category });
    }
    if (params.isSecret !== undefined) {
      query.andWhere('c.isSecret = :isSecret', { isSecret: params.isSecret });
    }
    if (params.search) {
      query.andWhere(
        '(c.key ILIKE :search OR c.name ILIKE :search OR c.description ILIKE :search)',
        { search: `%${params.search}%` },
      );
    }

    const page = params.page || 1;
    const limit = params.limit || 50;

    query.orderBy('c.category', 'ASC').addOrderBy('c.sortOrder', 'ASC').addOrderBy('c.key', 'ASC');
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items: items.map((c) => this.maskSecretConfig(c)), total };
  }

  async bulkUpdateConfigs(
    updates: Array<{ key: string; value: unknown }>,
    updatedBy: string,
  ): Promise<GlobalConfig[]> {
    const results: GlobalConfig[] = [];

    for (const update of updates) {
      const config = await this.globalConfigRepo.findOne({ where: { key: update.key } });
      if (config && !config.isReadOnly) {
        const updated = await this.updateConfig(config.id, update.value, updatedBy);
        results.push(updated);
      }
    }

    return results;
  }

  private validateConfigValue(
    value: unknown,
    validation: GlobalConfig['validation'],
  ): void {
    if (!validation) return;

    if (validation.required && (value === null || value === undefined || value === '')) {
      throw new BadRequestException('Value is required');
    }

    if (typeof value === 'number') {
      if (validation.min !== undefined && value < validation.min) {
        throw new BadRequestException(`Value must be at least ${validation.min}`);
      }
      if (validation.max !== undefined && value > validation.max) {
        throw new BadRequestException(`Value must be at most ${validation.max}`);
      }
    }

    if (typeof value === 'string') {
      if (validation.minLength !== undefined && value.length < validation.minLength) {
        throw new BadRequestException(`Value must be at least ${validation.minLength} characters`);
      }
      if (validation.maxLength !== undefined && value.length > validation.maxLength) {
        throw new BadRequestException(`Value must be at most ${validation.maxLength} characters`);
      }
      if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
        throw new BadRequestException('Value does not match required pattern');
      }
    }

    if (validation.allowedValues && !validation.allowedValues.includes(value)) {
      throw new BadRequestException(`Value must be one of: ${validation.allowedValues.join(', ')}`);
    }
  }

  private maskSecretConfig(config: GlobalConfig): GlobalConfig {
    if (config.isSecret) {
      return { ...config, value: '********' };
    }
    return config;
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
    const [toggles, configs] = await Promise.all([
      this.featureToggleRepo.find(),
      this.globalConfigRepo.find(),
    ]);

    this.featureToggleCache.clear();
    toggles.forEach((t) => this.featureToggleCache.set(t.key, t));

    this.configCache.clear();
    configs.forEach((c) => this.configCache.set(c.key, c));

    this.lastCacheRefresh = new Date();
    this.logger.debug(`Refreshed caches: ${toggles.length} toggles, ${configs.length} configs`);
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
            toggle.rolloutSchedule.percentage + daysSinceStart * toggle.rolloutSchedule.incrementPerDay,
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
    const [currentVersion, maintenanceCheck, toggleCount, configCount] = await Promise.all([
      this.getCurrentVersion(),
      this.checkMaintenanceMode(),
      this.featureToggleRepo.count(),
      this.globalConfigRepo.count(),
    ]);

    return {
      version: currentVersion?.version || 'unknown',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      maintenanceMode: maintenanceCheck.isInMaintenance,
      featureToggles: toggleCount,
      activeConfigs: configCount,
    };
  }
}
