/**
 * Platform Configuration data layer (config-service backed).
 *
 * Pure mapping between config-service's effective-configuration rows and the
 * System Settings page's typed tab models, plus the per-tab write builders
 * (ORPHAN-HIGH-373). No React/transport imports — the transport lives in
 * hooks/usePlatformConfiguration.ts — so every function here is unit-testable.
 *
 * Value coercion: `value` arrives as GraphQLJSON. Seeded rows come back typed
 * (number/boolean/parsed json) because the store preserves value_type; keys
 * first created through setConfiguration come back as plain strings. The
 * coercers accept both so the page renders identically either way.
 */

/** The config-service `service` namespace that platform-scope settings live under. */
export const PLATFORM_CONFIGURATION_SERVICE = 'platform';

export interface EffectiveConfigurationRow {
  key: string;
  value: unknown;
  /** 'redacted' marks a secret FIELD; value is null when no secret is stored yet. */
  secretMode: 'none' | 'redacted';
  source: 'tenant' | 'system';
  version: number;
}

export interface PlatformConfigurationWrite {
  key: string;
  value: string;
  isSecret?: boolean;
}

// ============================================================================
// Tab models (owned here so the page and the write builders share one shape)
// ============================================================================

export interface GeneralConfig {
  platformName: string;
  platformVersion: string;
  maintenanceMode: boolean;
}

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  /** Write-only input; never populated from the API. */
  smtpPassword?: string;
  hasSmtpPassword?: boolean;
  fromAddress: string;
  fromName: string;
}

export interface SecurityConfig {
  sessionTimeoutMinutes: number;
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireNumbers: boolean;
  passwordRequireSymbols: boolean;
  enforceHttps: boolean;
}

export interface BillingConfig {
  stripeEnabled: boolean;
  stripePublicKey: string;
  /** Write-only input; never populated from the API. */
  stripeSecretKey: string;
  defaultCurrency: string;
  taxRate: number;
}

export interface RateLimitsConfig {
  globalRpm: number;
  perUserRpm: number;
  perTenantRpm: number;
  apiKeyRpm: number;
}

export interface PlatformSettingsSnapshot {
  general: GeneralConfig;
  email: EmailConfig;
  security: SecurityConfig;
  billing: BillingConfig;
  rateLimits: RateLimitsConfig;
}

// ============================================================================
// Defaults — mirror the seeded vocabulary so a missing row renders sensibly.
// ============================================================================

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettingsSnapshot = {
  general: {
    platformName: 'Aquaculture Platform',
    platformVersion: '1.0.0',
    maintenanceMode: false,
  },
  email: {
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: '',
    smtpPassword: '',
    hasSmtpPassword: false,
    fromAddress: 'noreply@aquaculture.io',
    fromName: 'Aquaculture Platform',
  },
  security: {
    sessionTimeoutMinutes: 480,
    maxLoginAttempts: 5,
    lockoutDurationMinutes: 30,
    passwordMinLength: 8,
    passwordRequireUppercase: true,
    passwordRequireNumbers: true,
    passwordRequireSymbols: false,
    enforceHttps: true,
  },
  billing: {
    stripeEnabled: false,
    stripePublicKey: '',
    stripeSecretKey: '',
    defaultCurrency: 'USD',
    taxRate: 0,
  },
  rateLimits: {
    globalRpm: 1000,
    perUserRpm: 100,
    perTenantRpm: 500,
    apiKeyRpm: 60,
  },
};

// ============================================================================
// Coercion — GraphQLJSON values may be typed or canonical strings.
// ============================================================================

type RowMap = Map<string, EffectiveConfigurationRow>;

function toRowMap(rows: readonly EffectiveConfigurationRow[]): RowMap {
  return new Map(rows.map((row) => [row.key, row]));
}

export function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

function readString(map: RowMap, key: string, fallback: string): string {
  const row = map.get(key);
  return row ? coerceString(row.value, fallback) : fallback;
}

function readNumber(map: RowMap, key: string, fallback: number): number {
  const row = map.get(key);
  return row ? coerceNumber(row.value, fallback) : fallback;
}

function readBoolean(map: RowMap, key: string, fallback: boolean): boolean {
  const row = map.get(key);
  return row ? coerceBoolean(row.value, fallback) : fallback;
}

/** A secret is "stored" when its row exists and carries a non-null value. */
function hasStoredSecret(map: RowMap, key: string): boolean {
  const row = map.get(key);
  return row !== undefined && row.value !== null && row.value !== '';
}

// ============================================================================
// Read mapping
// ============================================================================

export function mapPlatformSettings(
  rows: readonly EffectiveConfigurationRow[],
): PlatformSettingsSnapshot {
  const map = toRowMap(rows);
  const defaults = DEFAULT_PLATFORM_SETTINGS;

  return {
    general: {
      platformName: readString(map, 'platform.name', defaults.general.platformName),
      platformVersion: readString(map, 'platform.version', defaults.general.platformVersion),
      maintenanceMode: readBoolean(
        map,
        'maintenance.mode_enabled',
        defaults.general.maintenanceMode,
      ),
    },
    email: {
      smtpHost: readString(map, 'email.smtp_host', defaults.email.smtpHost),
      smtpPort: readNumber(map, 'email.smtp_port', defaults.email.smtpPort),
      smtpSecure: readBoolean(map, 'email.smtp_secure', defaults.email.smtpSecure),
      smtpUsername: readString(map, 'email.smtp_username', defaults.email.smtpUsername),
      smtpPassword: '',
      hasSmtpPassword: hasStoredSecret(map, 'email.smtp_password'),
      fromAddress: readString(map, 'email.from_address', defaults.email.fromAddress),
      fromName: readString(map, 'email.from_name', defaults.email.fromName),
    },
    security: {
      sessionTimeoutMinutes: readNumber(
        map,
        'security.session_timeout_minutes',
        defaults.security.sessionTimeoutMinutes,
      ),
      maxLoginAttempts: readNumber(
        map,
        'security.max_login_attempts',
        defaults.security.maxLoginAttempts,
      ),
      lockoutDurationMinutes: readNumber(
        map,
        'security.lockout_duration_minutes',
        defaults.security.lockoutDurationMinutes,
      ),
      passwordMinLength: readNumber(
        map,
        'security.password_min_length',
        defaults.security.passwordMinLength,
      ),
      passwordRequireUppercase: readBoolean(
        map,
        'security.password_require_uppercase',
        defaults.security.passwordRequireUppercase,
      ),
      passwordRequireNumbers: readBoolean(
        map,
        'security.password_require_numbers',
        defaults.security.passwordRequireNumbers,
      ),
      passwordRequireSymbols: readBoolean(
        map,
        'security.password_require_symbols',
        defaults.security.passwordRequireSymbols,
      ),
      enforceHttps: readBoolean(map, 'security.enforce_https', defaults.security.enforceHttps),
    },
    billing: {
      stripeEnabled: readBoolean(map, 'billing.stripe_enabled', defaults.billing.stripeEnabled),
      stripePublicKey: readString(
        map,
        'billing.stripe_public_key',
        defaults.billing.stripePublicKey,
      ),
      stripeSecretKey: '',
      defaultCurrency: readString(
        map,
        'billing.default_currency',
        defaults.billing.defaultCurrency,
      ),
      taxRate: readNumber(map, 'billing.tax_rate', defaults.billing.taxRate),
    },
    rateLimits: {
      globalRpm: readNumber(map, 'rate_limit.global_rpm', defaults.rateLimits.globalRpm),
      perUserRpm: readNumber(map, 'rate_limit.per_user_rpm', defaults.rateLimits.perUserRpm),
      perTenantRpm: readNumber(map, 'rate_limit.per_tenant_rpm', defaults.rateLimits.perTenantRpm),
      apiKeyRpm: readNumber(map, 'rate_limit.api_key_rpm', defaults.rateLimits.apiKeyRpm),
    },
  };
}

// ============================================================================
// Write builders — values are stored in their canonical string form; the
// store preserves each seeded row's value_type on non-secret upserts.
// ============================================================================

export function buildGeneralWrites(maintenanceMode: boolean): PlatformConfigurationWrite[] {
  return [{ key: 'maintenance.mode_enabled', value: String(maintenanceMode) }];
}

export function buildEmailWrites(config: EmailConfig): PlatformConfigurationWrite[] {
  const writes: PlatformConfigurationWrite[] = [
    { key: 'email.smtp_host', value: config.smtpHost },
    { key: 'email.smtp_port', value: String(config.smtpPort) },
    { key: 'email.smtp_secure', value: String(config.smtpSecure) },
    { key: 'email.smtp_username', value: config.smtpUsername },
    { key: 'email.from_address', value: config.fromAddress },
    { key: 'email.from_name', value: config.fromName },
  ];
  // Write-only secret: only sent when the operator typed a new password, so a
  // save never clobbers the stored secret with the empty input placeholder.
  if (config.smtpPassword && config.smtpPassword.trim().length > 0) {
    writes.push({
      key: 'email.smtp_password',
      value: config.smtpPassword,
      isSecret: true,
    });
  }
  return writes;
}

export function buildSecurityWrites(config: SecurityConfig): PlatformConfigurationWrite[] {
  return [
    { key: 'security.session_timeout_minutes', value: String(config.sessionTimeoutMinutes) },
    { key: 'security.max_login_attempts', value: String(config.maxLoginAttempts) },
    { key: 'security.lockout_duration_minutes', value: String(config.lockoutDurationMinutes) },
    { key: 'security.password_min_length', value: String(config.passwordMinLength) },
    { key: 'security.password_require_uppercase', value: String(config.passwordRequireUppercase) },
    { key: 'security.password_require_numbers', value: String(config.passwordRequireNumbers) },
    { key: 'security.password_require_symbols', value: String(config.passwordRequireSymbols) },
    { key: 'security.enforce_https', value: String(config.enforceHttps) },
  ];
}

export function buildBillingWrites(config: BillingConfig): PlatformConfigurationWrite[] {
  const writes: PlatformConfigurationWrite[] = [
    { key: 'billing.stripe_enabled', value: String(config.stripeEnabled) },
    { key: 'billing.stripe_public_key', value: config.stripePublicKey },
    { key: 'billing.default_currency', value: config.defaultCurrency },
    { key: 'billing.tax_rate', value: String(config.taxRate) },
  ];
  // Write-only secret, same discipline as the SMTP password.
  if (config.stripeSecretKey && config.stripeSecretKey.trim().length > 0) {
    writes.push({
      key: 'billing.stripe_secret_key',
      value: config.stripeSecretKey,
      isSecret: true,
    });
  }
  return writes;
}

export function buildRateLimitWrites(config: RateLimitsConfig): PlatformConfigurationWrite[] {
  return [
    { key: 'rate_limit.global_rpm', value: String(config.globalRpm) },
    { key: 'rate_limit.per_user_rpm', value: String(config.perUserRpm) },
    { key: 'rate_limit.per_tenant_rpm', value: String(config.perTenantRpm) },
    { key: 'rate_limit.api_key_rpm', value: String(config.apiKeyRpm) },
  ];
}
