import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_SYSTEM_SETTINGS,
  SettingCategory,
  SettingValueType,
} from '../entities/system-setting.entity';
import { UpdateSystemSettingDto } from '../dto/settings.dto';

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

type UpdateSystemSettingInput = UpdateSystemSettingDto & { updatedBy?: string };

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

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  hasSmtpPassword: boolean;
  fromAddress: string;
  fromName: string;
}

export interface EmailSendConfig extends Omit<EmailConfig, 'hasSmtpPassword'> {
  smtpPassword: string;
}

const LEGACY_CONFIG_STORE_GONE =
  'admin-api direct system_settings writes are retired; use config-service effective configuration APIs';

@Injectable()
export class SystemSettingService {
  private readonly logger = new Logger(SystemSettingService.name);
  private readonly bootTime = new Date();

  seedDefaultSettings(): void {
    this.logger.log(
      'Skipping legacy system_settings seed; config-service owns system configuration',
    );
  }

  getAllSettings(includePrivate = true): SettingsByCategory {
    const grouped: SettingsByCategory = {};
    for (const setting of DEFAULT_SYSTEM_SETTINGS) {
      if (!includePrivate && !setting.isPublic) continue;
      const response = this.defaultSettingToResponse(setting.key);
      if (!grouped[setting.category]) grouped[setting.category] = [];
      const bucket = grouped[setting.category];
      if (bucket) bucket.push(response);
    }
    return grouped;
  }

  getSettingsByCategory(category: SettingCategory, includePrivate = true): SystemSettingResponse[] {
    const all = this.getAllSettings(includePrivate);
    return all[category] ?? [];
  }

  getSettingByKey(key: string): SystemSettingResponse {
    if (!DEFAULT_SYSTEM_SETTINGS.some((setting) => setting.key === key)) {
      throw new NotFoundException(`Setting with key "${key}" is not exposed by the legacy adapter`);
    }
    return this.defaultSettingToResponse(key);
  }

  getValue<T = unknown>(key: string, defaultValue?: T): T {
    const env = this.envOverrideForKey(key);
    if (env !== undefined) return this.coerceValue(env, defaultValue) as T;
    const setting = DEFAULT_SYSTEM_SETTINGS.find((candidate) => candidate.key === key);
    if (setting) return this.coerceValue(setting.value, defaultValue) as T;
    if (defaultValue !== undefined) return defaultValue;
    throw new NotFoundException(`Setting with key "${key}" is not exposed by the legacy adapter`);
  }

  getSettingsByKeys(keys: string[]): SystemSettingResponse[] {
    return keys
      .filter((key) => DEFAULT_SYSTEM_SETTINGS.some((setting) => setting.key === key))
      .map((key) => this.defaultSettingToResponse(key));
  }

  createSetting(_dto: CreateSystemSettingDto): never {
    this.throwLegacyGone();
  }

  updateSetting(_key: string, _dto: UpdateSystemSettingInput): never {
    this.throwLegacyGone();
  }

  resetToDefault(_key: string, _updatedBy?: string): never {
    this.throwLegacyGone();
  }

  deleteSetting(_key: string): never {
    this.throwLegacyGone();
  }

  bulkUpdate(_updates: { key: string; value: string }[], _updatedBy?: string): never {
    this.throwLegacyGone();
  }

  exportSettings(): Record<string, unknown> {
    const exported: Record<string, unknown> = {};
    for (const setting of DEFAULT_SYSTEM_SETTINGS) {
      if (setting.valueType === SettingValueType.ENCRYPTED) continue;
      exported[setting.key] = this.getValue(setting.key);
    }
    return exported;
  }

  importSettings(_data: Record<string, unknown>, _updatedBy?: string): never {
    this.throwLegacyGone();
  }

  getEmailConfig(): EmailConfig {
    return {
      smtpHost: this.env('SMTP_HOST', ''),
      smtpPort: this.envNumber('SMTP_PORT', 587),
      smtpSecure: this.envBoolean('SMTP_SECURE', false),
      smtpUsername: this.env('SMTP_USER', ''),
      hasSmtpPassword: this.env('SMTP_PASSWORD', '').trim().length > 0,
      fromAddress: this.env('SMTP_FROM', 'noreply@aquaculture.io'),
      fromName: this.env('SMTP_FROM_NAME', 'Aquaculture Platform'),
    };
  }

  getEmailConfigForSending(): EmailSendConfig {
    const config = this.getEmailConfig();
    return {
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUsername: config.smtpUsername,
      smtpPassword: this.env('SMTP_PASSWORD', ''),
      fromAddress: config.fromAddress,
      fromName: config.fromName,
    };
  }

  updateEmailConfig(
    _config: {
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
      smtpUsername?: string;
      smtpPassword?: string;
      fromAddress?: string;
      fromName?: string;
    },
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getSecurityConfig(): {
    sessionTimeoutMinutes: number;
    maxLoginAttempts: number;
    lockoutDurationMinutes: number;
    passwordMinLength: number;
    passwordRequireUppercase: boolean;
    passwordRequireNumbers: boolean;
    passwordRequireSymbols: boolean;
    mfaEnabled: boolean;
    enforceHttps: boolean;
  } {
    return {
      sessionTimeoutMinutes: this.getValue('security.session_timeout_minutes', 60),
      maxLoginAttempts: this.getValue('security.max_login_attempts', 5),
      lockoutDurationMinutes: this.getValue('security.lockout_duration_minutes', 30),
      passwordMinLength: this.getValue('security.password_min_length', 8),
      passwordRequireUppercase: this.getValue('security.password_require_uppercase', true),
      passwordRequireNumbers: this.getValue('security.password_require_numbers', true),
      passwordRequireSymbols: this.getValue('security.password_require_symbols', false),
      mfaEnabled: this.getValue('security.mfa_enabled', true),
      enforceHttps: this.getValue('security.enforce_https', true),
    };
  }

  updateSecurityConfig(
    _config: {
      sessionTimeoutMinutes?: number;
      maxLoginAttempts?: number;
      lockoutDurationMinutes?: number;
      passwordMinLength?: number;
      passwordRequireUppercase?: boolean;
      passwordRequireNumbers?: boolean;
      passwordRequireSymbols?: boolean;
      mfaEnabled?: boolean;
      enforceHttps?: boolean;
    },
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getRateLimitConfig(): {
    globalRpm: number;
    perUserRpm: number;
    perTenantRpm: number;
    apiKeyRpm: number;
  } {
    return {
      globalRpm: this.getValue('rate_limit.global_rpm', 1000),
      perUserRpm: this.getValue('rate_limit.per_user_rpm', 100),
      perTenantRpm: this.getValue('rate_limit.per_tenant_rpm', 500),
      apiKeyRpm: this.getValue('rate_limit.api_key_rpm', 60),
    };
  }

  updateRateLimitConfig(
    _config: {
      globalRpm?: number;
      perUserRpm?: number;
      perTenantRpm?: number;
      apiKeyRpm?: number;
    },
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getMaintenanceStatus(): {
    enabled: boolean;
    message: string;
    allowedIps: string[];
  } {
    return {
      enabled: this.envBoolean('MAINTENANCE_MODE', false),
      message: this.env('MAINTENANCE_MESSAGE', 'System is under maintenance'),
      allowedIps: this.env('MAINTENANCE_ALLOWED_IPS', '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }

  setMaintenanceMode(
    _enabled: boolean,
    _message?: string,
    _allowedIps?: string[],
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  getBillingConfig(): {
    currency: string;
    taxRate: number;
    invoiceDueDays: number;
    gracePeriodDays: number;
  } {
    return {
      currency: this.env('BILLING_CURRENCY', 'USD'),
      taxRate: this.envNumber('BILLING_TAX_RATE', 0),
      invoiceDueDays: this.envNumber('BILLING_INVOICE_DUE_DAYS', 30),
      gracePeriodDays: this.envNumber('BILLING_GRACE_PERIOD_DAYS', 7),
    };
  }

  updateBillingConfig(
    _config: {
      currency?: string;
      taxRate?: number;
      invoiceDueDays?: number;
      gracePeriodDays?: number;
    },
    _updatedBy?: string,
  ): never {
    this.throwLegacyGone();
  }

  isFeatureEnabled(featureKey: string, defaultValue = false): boolean {
    const envKey = `FEATURE_${featureKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    return this.envBoolean(envKey, defaultValue);
  }

  private defaultSettingToResponse(key: string): SystemSettingResponse {
    const setting = DEFAULT_SYSTEM_SETTINGS.find((candidate) => candidate.key === key);
    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" is not exposed by the legacy adapter`);
    }
    return {
      id: `legacy:${setting.key}`,
      key: setting.key,
      value: this.coerceByType(
        this.envOverrideForKey(setting.key) ?? setting.value,
        setting.valueType,
      ),
      valueType: setting.valueType,
      category: setting.category,
      description: setting.description,
      displayName: setting.displayName,
      isPublic: setting.isPublic ?? false,
      isReadOnly: true,
      requiresRestart: setting.requiresRestart ?? false,
      defaultValue: this.coerceByType(setting.value, setting.valueType),
      updatedAt: this.bootTime,
    };
  }

  private envOverrideForKey(key: string): string | undefined {
    const explicit = process.env[`SYSTEM_SETTING_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`];
    if (explicit !== undefined) return explicit;
    const direct: Record<string, string | undefined> = {
      'email.smtp_host': process.env['SMTP_HOST'],
      'email.smtp_port': process.env['SMTP_PORT'],
      'email.smtp_secure': process.env['SMTP_SECURE'],
      'email.smtp_username': process.env['SMTP_USER'],
      'email.smtp_password': process.env['SMTP_PASSWORD'],
      'email.from_address': process.env['SMTP_FROM'],
      'email.from_name': process.env['SMTP_FROM_NAME'],
      'maintenance.mode_enabled': process.env['MAINTENANCE_MODE'],
      'maintenance.message': process.env['MAINTENANCE_MESSAGE'],
      'maintenance.allowed_ips': process.env['MAINTENANCE_ALLOWED_IPS'],
    };
    return direct[key];
  }

  private coerceValue<T>(value: string, defaultValue?: T): unknown {
    if (typeof defaultValue === 'number') return Number(value);
    if (typeof defaultValue === 'boolean') return this.toBoolean(value);
    if (Array.isArray(defaultValue)) {
      try {
        return JSON.parse(value);
      } catch {
        return value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }
    if (typeof defaultValue === 'object' && defaultValue !== null) {
      try {
        return JSON.parse(value);
      } catch {
        return defaultValue;
      }
    }
    return value;
  }

  private coerceByType(value: string, valueType: SettingValueType): unknown {
    if (valueType === SettingValueType.NUMBER) return Number(value);
    if (valueType === SettingValueType.BOOLEAN) return this.toBoolean(value);
    if (valueType === SettingValueType.JSON) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (valueType === SettingValueType.ENCRYPTED) return '********';
    return value;
  }

  private env(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue;
  }

  private envNumber(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  private envBoolean(key: string, defaultValue: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    return this.toBoolean(raw);
  }

  private toBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
  }

  private throwLegacyGone(): never {
    throw new GoneException(LEGACY_CONFIG_STORE_GONE);
  }
}
