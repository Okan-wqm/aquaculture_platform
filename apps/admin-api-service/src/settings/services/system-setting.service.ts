import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  SystemSetting,
  SettingCategory,
  SettingValueType,
  DEFAULT_SYSTEM_SETTINGS,
} from '../entities/system-setting.entity';
import * as crypto from 'crypto';

// ============================================================================
// DTOs
// ============================================================================

export interface CreateSystemSettingDto {
  key: string;
  value: string;
  valueType?: SettingValueType;
  category: SettingCategory;
  description?: string;
  displayName?: string;
  isPublic?: boolean;
  isReadOnly?: boolean;
  requiresRestart?: boolean;
  defaultValue?: string;
  validationRule?: string;
  sortOrder?: number;
}

export interface UpdateSystemSettingDto {
  value?: string;
  description?: string;
  displayName?: string;
  isPublic?: boolean;
  requiresRestart?: boolean;
  sortOrder?: number;
  updatedBy?: string;
}

export interface SystemSettingResponse {
  id: string;
  key: string;
  value: unknown;
  valueType: SettingValueType;
  category: SettingCategory;
  description?: string;
  displayName?: string;
  isPublic: boolean;
  isReadOnly: boolean;
  requiresRestart: boolean;
  defaultValue?: unknown;
  updatedAt: Date;
}

export interface SettingsByCategory {
  [category: string]: SystemSettingResponse[];
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class SystemSettingService {
  private readonly logger = new Logger(SystemSettingService.name);
  private readonly encryptionKey: string;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly settingRepository: Repository<SystemSetting>,
  ) {
    this.encryptionKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Seed default settings on application startup
   */
  async seedDefaultSettings(): Promise<void> {
    this.logger.log('Checking for missing default settings...');

    const existingKeys = (await this.settingRepository.find()).map(s => s.key);
    const missingSettings = DEFAULT_SYSTEM_SETTINGS.filter(
      s => !existingKeys.includes(s.key)
    );

    if (missingSettings.length === 0) {
      this.logger.log('All default settings already exist');
      return;
    }

    const settings = missingSettings.map(s =>
      this.settingRepository.create({
        key: s.key,
        value: s.value,
        valueType: s.valueType,
        category: s.category,
        description: s.description,
        displayName: s.displayName,
        isPublic: s.isPublic ?? false,
        isReadOnly: s.isReadOnly ?? false,
        requiresRestart: s.requiresRestart ?? false,
        defaultValue: s.value,
      })
    );

    await this.settingRepository.save(settings);
    this.logger.log(`Seeded ${missingSettings.length} default settings`);
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Get all settings grouped by category
   */
  async getAllSettings(includePrivate = true): Promise<SettingsByCategory> {
    const query = this.settingRepository.createQueryBuilder('setting');

    if (!includePrivate) {
      query.where('setting.isPublic = :isPublic', { isPublic: true });
    }

    query.orderBy('setting.category', 'ASC').addOrderBy('setting.sortOrder', 'ASC');

    const settings = await query.getMany();
    const grouped: SettingsByCategory = {};

    for (const setting of settings) {
      const category = setting.category;
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category]!.push(this.toResponse(setting));
    }

    return grouped;
  }

  /**
   * Get settings by category
   */
  async getSettingsByCategory(
    category: SettingCategory,
    includePrivate = true,
  ): Promise<SystemSettingResponse[]> {
    const query = this.settingRepository
      .createQueryBuilder('setting')
      .where('setting.category = :category', { category });

    if (!includePrivate) {
      query.andWhere('setting.isPublic = :isPublic', { isPublic: true });
    }

    query.orderBy('setting.sortOrder', 'ASC');

    const settings = await query.getMany();
    return settings.map(s => this.toResponse(s));
  }

  /**
   * Get setting by key
   */
  async getSettingByKey(key: string): Promise<SystemSettingResponse> {
    const setting = await this.settingRepository.findOne({ where: { key } });

    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }

    return this.toResponse(setting);
  }

  /**
   * Get raw setting value (for internal use)
   */
  async getValue<T = unknown>(key: string, defaultValue?: T): Promise<T> {
    const setting = await this.settingRepository.findOne({ where: { key } });

    if (!setting) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }

    return this.parseValue(setting) as T;
  }

  /**
   * Get multiple settings by keys
   */
  async getSettingsByKeys(keys: string[]): Promise<SystemSettingResponse[]> {
    const settings = await this.settingRepository.find({
      where: { key: In(keys) },
    });
    return settings.map(s => this.toResponse(s));
  }

  /**
   * Create a new setting
   */
  async createSetting(dto: CreateSystemSettingDto): Promise<SystemSettingResponse> {
    const existing = await this.settingRepository.findOne({ where: { key: dto.key } });

    if (existing) {
      throw new ConflictException(`Setting with key "${dto.key}" already exists`);
    }

    // Validate value if validation rule exists
    if (dto.validationRule) {
      this.validateValue(dto.value, dto.validationRule, dto.valueType || SettingValueType.STRING);
    }

    // Encrypt if needed
    const valueToStore =
      dto.valueType === SettingValueType.ENCRYPTED
        ? this.encryptValue(dto.value)
        : dto.value;

    const setting = this.settingRepository.create({
      ...dto,
      value: valueToStore,
      valueType: dto.valueType || SettingValueType.STRING,
    });

    const saved = await this.settingRepository.save(setting);
    this.logger.log(`Created setting: ${dto.key}`);
    return this.toResponse(saved);
  }

  /**
   * Update a setting
   */
  async updateSetting(key: string, dto: UpdateSystemSettingDto): Promise<SystemSettingResponse> {
    const setting = await this.settingRepository.findOne({ where: { key } });

    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }

    if (setting.isReadOnly) {
      throw new BadRequestException(`Setting "${key}" is read-only`);
    }

    if (dto.value !== undefined) {
      // Validate if rule exists
      if (setting.validationRule) {
        this.validateValue(dto.value, setting.validationRule, setting.valueType);
      }

      // Encrypt if needed
      setting.value =
        setting.valueType === SettingValueType.ENCRYPTED
          ? this.encryptValue(dto.value)
          : dto.value;
    }

    if (dto.description !== undefined) setting.description = dto.description;
    if (dto.displayName !== undefined) setting.displayName = dto.displayName;
    if (dto.isPublic !== undefined) setting.isPublic = dto.isPublic;
    if (dto.requiresRestart !== undefined) setting.requiresRestart = dto.requiresRestart;
    if (dto.sortOrder !== undefined) setting.sortOrder = dto.sortOrder;
    if (dto.updatedBy) setting.updatedBy = dto.updatedBy;

    const saved = await this.settingRepository.save(setting);
    this.logger.log(`Updated setting: ${key}`);
    return this.toResponse(saved);
  }

  /**
   * Reset setting to default value
   */
  async resetToDefault(key: string): Promise<SystemSettingResponse> {
    const setting = await this.settingRepository.findOne({ where: { key } });

    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }

    if (setting.isReadOnly) {
      throw new BadRequestException(`Setting "${key}" is read-only`);
    }

    if (!setting.defaultValue) {
      throw new BadRequestException(`Setting "${key}" has no default value`);
    }

    setting.value = setting.defaultValue;
    const saved = await this.settingRepository.save(setting);

    this.logger.log(`Reset setting to default: ${key}`);
    return this.toResponse(saved);
  }

  /**
   * Delete a custom setting
   */
  async deleteSetting(key: string): Promise<void> {
    const setting = await this.settingRepository.findOne({ where: { key } });

    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }

    if (setting.isReadOnly) {
      throw new BadRequestException(`Cannot delete read-only setting "${key}"`);
    }

    // Check if it's a default setting
    const isDefault = DEFAULT_SYSTEM_SETTINGS.some(s => s.key === key);
    if (isDefault) {
      throw new BadRequestException(`Cannot delete default setting "${key}"`);
    }

    await this.settingRepository.remove(setting);
    this.logger.log(`Deleted setting: ${key}`);
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Update multiple settings at once
   */
  async bulkUpdate(
    updates: { key: string; value: string }[],
    updatedBy?: string,
  ): Promise<SystemSettingResponse[]> {
    const results: SystemSettingResponse[] = [];
    const requiresRestart: string[] = [];

    for (const update of updates) {
      const result = await this.updateSetting(update.key, {
        value: update.value,
        updatedBy,
      });
      results.push(result);

      if (result.requiresRestart) {
        requiresRestart.push(update.key);
      }
    }

    if (requiresRestart.length > 0) {
      this.logger.warn(
        `Settings requiring restart were updated: ${requiresRestart.join(', ')}`
      );
    }

    return results;
  }

  /**
   * Export all settings as JSON
   */
  async exportSettings(): Promise<Record<string, unknown>> {
    const settings = await this.settingRepository.find({
      where: { isReadOnly: false },
    });

    const exported: Record<string, unknown> = {};
    for (const setting of settings) {
      // Skip encrypted values for export
      if (setting.valueType === SettingValueType.ENCRYPTED) {
        continue;
      }
      exported[setting.key] = this.parseValue(setting);
    }

    return exported;
  }

  /**
   * Import settings from JSON
   */
  async importSettings(
    data: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [key, value] of Object.entries(data)) {
      try {
        const setting = await this.settingRepository.findOne({ where: { key } });

        if (!setting) {
          errors.push(`Setting "${key}" does not exist`);
          skipped++;
          continue;
        }

        if (setting.isReadOnly) {
          errors.push(`Setting "${key}" is read-only`);
          skipped++;
          continue;
        }

        if (setting.valueType === SettingValueType.ENCRYPTED) {
          errors.push(`Cannot import encrypted setting "${key}"`);
          skipped++;
          continue;
        }

        await this.updateSetting(key, {
          value: this.stringifyValue(value, setting.valueType),
          updatedBy,
        });
        imported++;
      } catch (error) {
        errors.push(`Failed to import "${key}": ${(error as Error).message}`);
        skipped++;
      }
    }

    this.logger.log(`Imported ${imported} settings, skipped ${skipped}`);
    return { imported, skipped, errors };
  }

  // ============================================================================
  // Specialized Getters
  // ============================================================================

  /**
   * Get email configuration
   */
  async getEmailConfig(): Promise<{
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUsername: string;
    smtpPassword: string;
    fromAddress: string;
    fromName: string;
  }> {
    const keys = [
      'email.smtp_host',
      'email.smtp_port',
      'email.smtp_secure',
      'email.smtp_username',
      'email.smtp_password',
      'email.from_address',
      'email.from_name',
    ];

    const settings = await this.settingRepository.find({
      where: { key: In(keys) },
    });

    const getValue = (key: string, defaultValue: unknown) => {
      const setting = settings.find(s => s.key === key);
      return setting ? this.parseValue(setting) : defaultValue;
    };

    return {
      smtpHost: getValue('email.smtp_host', '') as string,
      smtpPort: getValue('email.smtp_port', 587) as number,
      smtpSecure: getValue('email.smtp_secure', true) as boolean,
      smtpUsername: getValue('email.smtp_username', '') as string,
      smtpPassword: getValue('email.smtp_password', '') as string,
      fromAddress: getValue('email.from_address', 'noreply@aquaculture.io') as string,
      fromName: getValue('email.from_name', 'Aquaculture Platform') as string,
    };
  }

  /**
   * Update email configuration
   */
  async updateEmailConfig(config: {
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUsername?: string;
    smtpPassword?: string;
    fromAddress?: string;
    fromName?: string;
  }, updatedBy?: string): Promise<void> {
    const keyMap: Record<string, string> = {
      smtpHost: 'email.smtp_host',
      smtpPort: 'email.smtp_port',
      smtpSecure: 'email.smtp_secure',
      smtpUsername: 'email.smtp_username',
      smtpPassword: 'email.smtp_password',
      fromAddress: 'email.from_address',
      fromName: 'email.from_name',
    };

    for (const [field, key] of Object.entries(keyMap)) {
      const value = config[field as keyof typeof config];
      if (value !== undefined) {
        await this.upsertSetting(key, value, updatedBy);
      }
    }

    this.logger.log('Email configuration updated');
  }

  /**
   * Upsert a setting (create or update)
   */
  private async upsertSetting(key: string, value: unknown, updatedBy?: string): Promise<void> {
    let setting = await this.settingRepository.findOne({ where: { key } });

    const valueType = typeof value === 'number' ? SettingValueType.NUMBER :
                      typeof value === 'boolean' ? SettingValueType.BOOLEAN : SettingValueType.STRING;
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

    if (setting) {
      setting.value = stringValue;
      setting.updatedBy = updatedBy || 'system';
    } else {
      setting = this.settingRepository.create({
        key,
        value: stringValue,
        valueType,
        category: this.getCategoryFromKey(key),
        displayName: key.replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        isPublic: false,
        isReadOnly: false,
        updatedBy: updatedBy || 'system',
      });
    }

    await this.settingRepository.save(setting);
  }

  /**
   * Get category from setting key
   */
  private getCategoryFromKey(key: string): SettingCategory {
    const prefix = key.split('.')[0] || '';
    const categoryMap: Record<string, SettingCategory> = {
      'email': SettingCategory.EMAIL,
      'security': SettingCategory.SECURITY,
      'rate_limit': SettingCategory.RATE_LIMIT,
      'storage': SettingCategory.STORAGE,
      'billing': SettingCategory.BILLING,
      'maintenance': SettingCategory.MAINTENANCE,
      'notification': SettingCategory.NOTIFICATION,
      'feature': SettingCategory.FEATURE_FLAG,
      'integration': SettingCategory.INTEGRATION,
      'sms': SettingCategory.SMS,
    };
    return categoryMap[prefix] ?? SettingCategory.GENERAL;
  }

  /**
   * Get security configuration
   */
  async getSecurityConfig(): Promise<{
    sessionTimeoutMinutes: number;
    maxLoginAttempts: number;
    lockoutDurationMinutes: number;
    passwordMinLength: number;
    mfaEnabled: boolean;
    enforceHttps: boolean;
  }> {
    return {
      sessionTimeoutMinutes: await this.getValue('security.session_timeout_minutes', 480),
      maxLoginAttempts: await this.getValue('security.max_login_attempts', 5),
      lockoutDurationMinutes: await this.getValue('security.lockout_duration_minutes', 30),
      passwordMinLength: await this.getValue('security.password_min_length', 8),
      mfaEnabled: await this.getValue('security.mfa_enabled', true),
      enforceHttps: await this.getValue('security.enforce_https', true),
    };
  }

  /**
   * Get rate limit configuration
   */
  async getRateLimitConfig(): Promise<{
    globalRpm: number;
    perUserRpm: number;
    perTenantRpm: number;
    apiKeyRpm: number;
  }> {
    return {
      globalRpm: await this.getValue('rate_limit.global_rpm', 1000),
      perUserRpm: await this.getValue('rate_limit.per_user_rpm', 100),
      perTenantRpm: await this.getValue('rate_limit.per_tenant_rpm', 500),
      apiKeyRpm: await this.getValue('rate_limit.api_key_rpm', 60),
    };
  }

  /**
   * Get maintenance mode status
   */
  async getMaintenanceStatus(): Promise<{
    enabled: boolean;
    message: string;
    allowedIps: string[];
  }> {
    return {
      enabled: await this.getValue('maintenance.mode_enabled', false),
      message: await this.getValue('maintenance.message', 'System is under maintenance'),
      allowedIps: await this.getValue('maintenance.allowed_ips', []),
    };
  }

  /**
   * Toggle maintenance mode
   */
  async setMaintenanceMode(
    enabled: boolean,
    message?: string,
    allowedIps?: string[],
    updatedBy?: string,
  ): Promise<void> {
    await this.updateSetting('maintenance.mode_enabled', {
      value: String(enabled),
      updatedBy,
    });

    if (message !== undefined) {
      await this.updateSetting('maintenance.message', {
        value: message,
        updatedBy,
      });
    }

    if (allowedIps !== undefined) {
      await this.updateSetting('maintenance.allowed_ips', {
        value: JSON.stringify(allowedIps),
        updatedBy,
      });
    }

    this.logger.warn(`Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${updatedBy}`);
  }

  /**
   * Check if a feature is enabled
   */
  async isFeatureEnabled(featureKey: string, defaultValue = false): Promise<boolean> {
    try {
      return await this.getValue(`feature.${featureKey}`, defaultValue);
    } catch {
      return defaultValue;
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Parse stored value based on type
   */
  private parseValue(setting: SystemSetting): unknown {
    switch (setting.valueType) {
      case SettingValueType.NUMBER:
        return Number(setting.value);
      case SettingValueType.BOOLEAN:
        return setting.value === 'true';
      case SettingValueType.JSON:
        try {
          return JSON.parse(setting.value);
        } catch {
          return setting.value;
        }
      case SettingValueType.ENCRYPTED:
        return '********'; // Never expose encrypted values
      default:
        return setting.value;
    }
  }

  /**
   * Stringify value for storage
   */
  private stringifyValue(value: unknown, valueType: SettingValueType): string {
    if (valueType === SettingValueType.JSON) {
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Convert entity to response DTO
   */
  private toResponse(setting: SystemSetting): SystemSettingResponse {
    return {
      id: setting.id,
      key: setting.key,
      value: this.parseValue(setting),
      valueType: setting.valueType,
      category: setting.category,
      description: setting.description,
      displayName: setting.displayName,
      isPublic: setting.isPublic,
      isReadOnly: setting.isReadOnly,
      requiresRestart: setting.requiresRestart,
      defaultValue: setting.defaultValue
        ? this.parseValue({ ...setting, value: setting.defaultValue })
        : undefined,
      updatedAt: setting.updatedAt,
    };
  }

  /**
   * Validate value against validation rule
   */
  private validateValue(value: string, rule: string, valueType: SettingValueType): void {
    // Check if rule is a regex
    if (rule.startsWith('/') && rule.endsWith('/')) {
      const regex = new RegExp(rule.slice(1, -1));
      if (!regex.test(value)) {
        throw new BadRequestException(`Value does not match validation rule: ${rule}`);
      }
      return;
    }

    // Check if rule is a JSON schema (simplified)
    try {
      const schema = JSON.parse(rule);
      if (schema.min !== undefined && Number(value) < schema.min) {
        throw new BadRequestException(`Value must be at least ${schema.min}`);
      }
      if (schema.max !== undefined && Number(value) > schema.max) {
        throw new BadRequestException(`Value must be at most ${schema.max}`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw new BadRequestException(`Value must be one of: ${schema.enum.join(', ')}`);
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // If not valid JSON schema, treat as literal match
    }
  }

  /**
   * Get billing configuration
   */
  async getBillingConfig(): Promise<{
    stripeEnabled: boolean;
    defaultCurrency: string;
    taxRate: number;
    invoiceDueDays: number;
  }> {
    return {
      stripeEnabled: await this.getValue('billing.stripe_enabled', false),
      defaultCurrency: await this.getValue('billing.default_currency', 'USD'),
      taxRate: await this.getValue('billing.tax_rate', 0),
      invoiceDueDays: await this.getValue('billing.invoice_due_days', 30),
    };
  }

  /**
   * Update billing configuration
   */
  async updateBillingConfig(
    config: {
      stripeEnabled?: boolean;
      defaultCurrency?: string;
      taxRate?: number;
      invoiceDueDays?: number;
    },
    updatedBy?: string,
  ): Promise<void> {
    if (config.stripeEnabled !== undefined) {
      await this.updateSetting('billing.stripe_enabled', {
        value: String(config.stripeEnabled),
        updatedBy,
      });
    }

    if (config.defaultCurrency !== undefined) {
      await this.updateSetting('billing.default_currency', {
        value: config.defaultCurrency,
        updatedBy,
      });
    }

    if (config.taxRate !== undefined) {
      await this.updateSetting('billing.tax_rate', {
        value: String(config.taxRate),
        updatedBy,
      });
    }

    if (config.invoiceDueDays !== undefined) {
      await this.updateSetting('billing.invoice_due_days', {
        value: String(config.invoiceDueDays),
        updatedBy,
      });
    }
  }

  /**
   * Encrypt sensitive value
   */
  private encryptValue(value: string): string {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt sensitive value (for internal use only)
   */
  private decryptValue(encryptedValue: string): string {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const parts = encryptedValue.split(':');
    const ivHex = parts[0];
    const encrypted = parts[1];

    if (!ivHex || !encrypted) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
