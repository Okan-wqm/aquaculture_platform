/**
 * Tenant settings vocabulary — the single author of the per-tenant
 * configuration key set.
 *
 * # Why this file exists
 *
 * `admin.tenant_configurations` was dropped by admin-api migration
 * 1801400000000 on the strength of a claim in a docblock: "config-service owns
 * tenant configuration now". It did not. config-service's resolver derived
 * tenant scope exclusively from the caller's JWT, and SUPER_ADMIN is the
 * platform's only tenantless principal, so there was no way to address another
 * tenant's partition at all — and no tenant-config key had ever been defined,
 * let alone seeded. The successor was a sentence, not a store.
 *
 * What filled the gap was worse than an error page. admin-api's read paths
 * synthesized `createDefaultTenantConfiguration()` for every tenant and served
 * it as that tenant's configuration: identical values for every tenant, an id
 * of `legacy:<tenantId>`, epoch timestamps. The page loaded, the fields were
 * populated, and every save returned 410. An operator reading "MFA required:
 * off" was reading a constant in a TypeScript file, not a policy.
 *
 * This vocabulary is the missing definition. Every entry becomes a seeded
 * SYSTEM-tenant row (migration 1805500000000), so the existing
 * tenant-over-system effective merge answers a fresh tenant's reads with real
 * rows and a per-tenant override is an ordinary tenant row — the defaults stop
 * being code that pretends to be data.
 *
 * # One author, two consumers
 *
 * The seed migration derives its rows from this array, and the admin panel
 * derives its typed reader from it through `tools/codegen/admin-contracts`,
 * which emits the array into the panel's own tree. Neither side re-declares a
 * key, so neither side can drift from it.
 *
 * # What is deliberately NOT here
 *
 * API keys, webhook registrations and custom-domain verification. Those are
 * stateful operational workflows — hashed secrets, DNS token state machines,
 * delivery retry ledgers — not key-value configuration. Encoding them as config
 * rows would push a state machine into a JSON column, which is exactly the
 * escape hatch this codebase forbids. They are tracked separately
 * (ADMIN-HIGH-096).
 *
 * `usedStorageGB` is absent for a different reason: it is a MEASUREMENT, not a
 * setting. The retired shape carried it beside the quota, which is how a
 * fabricated default came to be rendered as a tenant's real disk usage.
 */

/**
 * The config-service `service` namespace tenant settings live under.
 *
 * Distinct from `platform` (ORPHAN-HIGH-373), which holds platform-wide system
 * settings. Both are ordinary rows in `config.configurations`; the namespace is
 * what keeps a tenant's session timeout from colliding with the platform's.
 */
export const TENANT_SETTINGS_SERVICE = 'tenant-settings';

/**
 * How a stored value is typed in `config.configurations.value_type`.
 *
 * `json` is this vocabulary's list form (allowed file types, IP lists, enabled
 * modules). No `secret` member: a tenant setting that needed encryption at rest
 * would be a credential, and credentials belong to the workflow that owns them
 * rather than to a settings page.
 */
export type TenantSettingValueType = 'string' | 'number' | 'boolean' | 'json';

/** The page tab an entry belongs to. Also groups the seeded rows' `category`. */
export type TenantSettingSection =
  | 'userLimits'
  | 'storage'
  | 'api'
  | 'branding'
  | 'security'
  | 'notifications'
  | 'features'
  | 'retention';

export interface TenantSettingDefinition {
  /** Stable wire key. Namespaced by section so a grep finds every reader. */
  readonly key: string;
  readonly section: TenantSettingSection;
  readonly valueType: TenantSettingValueType;
  /**
   * Canonical string form of the default, exactly as it is stored. The store
   * preserves `value_type`, so `'5'` under `number` reads back as `5`.
   */
  readonly defaultValue: string;
  readonly description: string;
  /**
   * Repo path of the code that READS this setting and changes behaviour because
   * of it, or `null` when nothing does yet.
   *
   * This field is the honest half of the migration. A settings page whose
   * values no runtime consults is theater, and the retired one was exactly
   * that; recording the consumer per key makes the difference between "stored"
   * and "enforced" a fact in the vocabulary rather than an assumption in the
   * reader's head. `tests/invariants/tenant-settings-vocabulary.spec.ts` holds
   * the count of nulls as a ratchet that can only fall, and asserts every
   * non-null path exists and mentions the key.
   */
  readonly enforcedBy: string | null;
}

/**
 * The tenant settings key set.
 *
 * Derived from the shape the retired `TenantConfiguration` interface served
 * (`apps/admin-api-service/src/settings/entities/tenant-configuration.entity.ts`
 * before its deletion), minus the operational workflows and the one
 * measurement, and with each field's default carried over verbatim from
 * `createDefaultTenantConfiguration` so a tenant's effective values do not
 * silently change on the day the real store arrives.
 */
export const TENANT_SETTINGS = [
  // ── User limits ──────────────────────────────────────────────────────────
  {
    key: 'limits.max_users',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '5',
    description: 'Maximum user accounts the tenant may hold',
    enforcedBy: null,
  },
  {
    key: 'limits.max_admins',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '2',
    description: 'Maximum tenant administrators',
    enforcedBy: null,
  },
  {
    key: 'limits.max_module_managers',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '3',
    description: 'Maximum module managers',
    enforcedBy: null,
  },
  {
    key: 'limits.max_concurrent_sessions',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '3',
    description: 'Maximum simultaneous sessions per user',
    enforcedBy: null,
  },
  {
    key: 'limits.session_timeout_minutes',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '480',
    description: 'Idle minutes before a session is ended',
    enforcedBy: null,
  },
  {
    key: 'limits.inactive_user_cleanup_days',
    section: 'userLimits',
    valueType: 'number',
    defaultValue: '90',
    description: 'Days of inactivity before an account is flagged for cleanup',
    enforcedBy: null,
  },
  {
    key: 'limits.allow_guest_access',
    section: 'userLimits',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Allow unauthenticated guest access to shared surfaces',
    enforcedBy: null,
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  {
    key: 'storage.total_gb',
    section: 'storage',
    valueType: 'number',
    defaultValue: '10',
    description: 'Storage quota in gigabytes',
    enforcedBy: null,
  },
  {
    key: 'storage.max_file_size_mb',
    section: 'storage',
    valueType: 'number',
    defaultValue: '50',
    description: 'Largest single upload accepted, in megabytes',
    enforcedBy: null,
  },
  {
    key: 'storage.allowed_file_types',
    section: 'storage',
    valueType: 'json',
    defaultValue:
      '["pdf","doc","docx","xls","xlsx","csv","jpg","jpeg","png","gif"]',
    description: 'Upload extension allowlist',
    enforcedBy: null,
  },
  {
    key: 'storage.file_versioning_enabled',
    section: 'storage',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Keep previous versions of replaced files',
    enforcedBy: null,
  },
  {
    key: 'storage.version_retention_count',
    section: 'storage',
    valueType: 'number',
    defaultValue: '3',
    description: 'How many previous versions to keep per file',
    enforcedBy: null,
  },
  {
    key: 'storage.compression_enabled',
    section: 'storage',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Compress stored objects',
    enforcedBy: null,
  },

  // ── API ──────────────────────────────────────────────────────────────────
  {
    key: 'api.enabled',
    section: 'api',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Allow the tenant to call the public API',
    enforcedBy: null,
  },
  {
    key: 'api.rate_limit_per_minute',
    section: 'api',
    valueType: 'number',
    defaultValue: '100',
    description: 'API requests per minute',
    enforcedBy: null,
  },
  {
    key: 'api.rate_limit_per_hour',
    section: 'api',
    valueType: 'number',
    defaultValue: '1000',
    description: 'API requests per hour',
    enforcedBy: null,
  },
  {
    key: 'api.rate_limit_per_day',
    section: 'api',
    valueType: 'number',
    defaultValue: '10000',
    description: 'API requests per day',
    enforcedBy: null,
  },
  {
    key: 'api.max_concurrent_requests',
    section: 'api',
    valueType: 'number',
    defaultValue: '10',
    description: 'Simultaneous in-flight API requests',
    enforcedBy: null,
  },
  {
    key: 'api.ip_allowlist',
    section: 'api',
    valueType: 'json',
    defaultValue: '[]',
    description: 'Source addresses permitted to use the API; empty means any',
    enforcedBy: null,
  },

  // ── Branding ─────────────────────────────────────────────────────────────
  {
    key: 'branding.company_name',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Name shown in the tenant UI and outbound email',
    enforcedBy: null,
  },
  {
    key: 'branding.logo_url',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Logo image URL',
    enforcedBy: null,
  },
  {
    key: 'branding.favicon_url',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Favicon URL',
    enforcedBy: null,
  },
  {
    key: 'branding.login_background_url',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Login screen background image URL',
    enforcedBy: null,
  },
  {
    key: 'branding.primary_color',
    section: 'branding',
    valueType: 'string',
    defaultValue: '#3B82F6',
    description: 'Primary brand colour',
    enforcedBy: null,
  },
  {
    key: 'branding.secondary_color',
    section: 'branding',
    valueType: 'string',
    defaultValue: '#6B7280',
    description: 'Secondary brand colour',
    enforcedBy: null,
  },
  {
    key: 'branding.accent_color',
    section: 'branding',
    valueType: 'string',
    defaultValue: '#10B981',
    description: 'Accent colour',
    enforcedBy: null,
  },
  {
    key: 'branding.header_color',
    section: 'branding',
    valueType: 'string',
    defaultValue: '#1F2937',
    description: 'Header background colour',
    enforcedBy: null,
  },
  {
    key: 'branding.font_family',
    section: 'branding',
    valueType: 'string',
    defaultValue: 'Inter, system-ui, sans-serif',
    description: 'UI font stack',
    enforcedBy: null,
  },
  {
    key: 'branding.support_email',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Support contact address shown to tenant users',
    enforcedBy: null,
  },
  {
    key: 'branding.support_phone',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Support contact phone shown to tenant users',
    enforcedBy: null,
  },
  {
    key: 'branding.privacy_policy_url',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Privacy policy URL',
    enforcedBy: null,
  },
  {
    key: 'branding.terms_of_service_url',
    section: 'branding',
    valueType: 'string',
    defaultValue: '',
    description: 'Terms of service URL',
    enforcedBy: null,
  },
  {
    key: 'branding.show_powered_by',
    section: 'branding',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Show the platform attribution footer',
    enforcedBy: null,
  },

  // ── Security ─────────────────────────────────────────────────────────────
  {
    key: 'security.mfa_required',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Require multi-factor authentication for every tenant user',
    enforcedBy: null,
  },
  {
    key: 'security.mfa_required_for_admins',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Require multi-factor authentication for tenant administrators',
    enforcedBy: null,
  },
  {
    key: 'security.password_min_length',
    section: 'security',
    valueType: 'number',
    defaultValue: '8',
    description: 'Minimum password length',
    enforcedBy: null,
  },
  {
    key: 'security.password_require_uppercase',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Passwords must contain an uppercase letter',
    enforcedBy: null,
  },
  {
    key: 'security.password_require_lowercase',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Passwords must contain a lowercase letter',
    enforcedBy: null,
  },
  {
    key: 'security.password_require_numbers',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Passwords must contain a digit',
    enforcedBy: null,
  },
  {
    key: 'security.password_require_special_chars',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Passwords must contain a symbol',
    enforcedBy: null,
  },
  {
    key: 'security.password_expiry_days',
    section: 'security',
    valueType: 'number',
    defaultValue: '0',
    description: 'Days before a password must be changed; 0 disables expiry',
    enforcedBy: null,
  },
  {
    key: 'security.password_history_count',
    section: 'security',
    valueType: 'number',
    defaultValue: '3',
    description: 'Previous passwords that may not be reused',
    enforcedBy: null,
  },
  {
    key: 'security.prevent_common_passwords',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Reject passwords found in the common-password list',
    enforcedBy: null,
  },
  {
    key: 'security.max_login_attempts',
    section: 'security',
    valueType: 'number',
    defaultValue: '5',
    description: 'Failed attempts before an account is locked out',
    enforcedBy: null,
  },
  {
    key: 'security.lockout_duration_minutes',
    section: 'security',
    valueType: 'number',
    defaultValue: '30',
    description: 'Lockout duration in minutes',
    enforcedBy: null,
  },
  {
    key: 'security.session_timeout_minutes',
    section: 'security',
    valueType: 'number',
    defaultValue: '480',
    description: 'Idle minutes before re-authentication is required',
    enforcedBy: null,
  },
  {
    key: 'security.remember_me_days',
    section: 'security',
    valueType: 'number',
    defaultValue: '30',
    description: 'Lifetime of a remembered session in days',
    enforcedBy: null,
  },
  {
    key: 'security.single_session_per_user',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'A new sign-in ends the previous session',
    enforcedBy: null,
  },
  {
    key: 'security.terminate_sessions_on_password_change',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'End every session when a password changes',
    enforcedBy: null,
  },
  {
    key: 'security.ip_allowlist_enabled',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Restrict sign-in to the address allowlist',
    enforcedBy: null,
  },
  {
    key: 'security.ip_allowlist',
    section: 'security',
    valueType: 'json',
    defaultValue: '[]',
    description: 'Addresses or CIDR ranges permitted to sign in',
    enforcedBy: null,
  },
  {
    key: 'security.ip_blocklist_enabled',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Refuse sign-in from the address blocklist',
    enforcedBy: null,
  },
  {
    key: 'security.ip_blocklist',
    section: 'security',
    valueType: 'json',
    defaultValue: '[]',
    description: 'Addresses or CIDR ranges refused at sign-in',
    enforcedBy: null,
  },
  {
    key: 'security.geo_blocking_enabled',
    section: 'security',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Apply the country allow/block lists',
    enforcedBy: null,
  },
  {
    key: 'security.allowed_countries',
    section: 'security',
    valueType: 'json',
    defaultValue: '[]',
    description: 'ISO country codes permitted to sign in',
    enforcedBy: null,
  },
  {
    key: 'security.blocked_countries',
    section: 'security',
    valueType: 'json',
    defaultValue: '[]',
    description: 'ISO country codes refused at sign-in',
    enforcedBy: null,
  },

  // ── Notifications ────────────────────────────────────────────────────────
  {
    key: 'notifications.email_enabled',
    section: 'notifications',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Send notification email to tenant users',
    enforcedBy: null,
  },
  {
    key: 'notifications.email_from_name',
    section: 'notifications',
    valueType: 'string',
    defaultValue: '',
    description: 'Display name on outbound notification email',
    enforcedBy: null,
  },
  {
    key: 'notifications.email_from_address',
    section: 'notifications',
    valueType: 'string',
    defaultValue: '',
    description: 'From address on outbound notification email',
    enforcedBy: null,
  },
  {
    key: 'notifications.sms_enabled',
    section: 'notifications',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Send notification SMS to tenant users',
    enforcedBy: null,
  },
  {
    key: 'notifications.push_enabled',
    section: 'notifications',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Send push notifications to tenant devices',
    enforcedBy: null,
  },
  {
    key: 'notifications.slack_enabled',
    section: 'notifications',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Relay notifications to Slack',
    enforcedBy: null,
  },
  {
    key: 'notifications.slack_default_channel',
    section: 'notifications',
    valueType: 'string',
    defaultValue: '',
    description: 'Slack channel notifications are relayed to',
    enforcedBy: null,
  },
  {
    key: 'notifications.digest_frequency',
    section: 'notifications',
    valueType: 'string',
    defaultValue: 'realtime',
    description: 'How often digests are sent: realtime, hourly, daily or weekly',
    enforcedBy: null,
  },
  {
    key: 'notifications.quiet_hours_enabled',
    section: 'notifications',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Suppress non-urgent notifications during quiet hours',
    enforcedBy: null,
  },
  {
    key: 'notifications.quiet_hours_start',
    section: 'notifications',
    valueType: 'string',
    defaultValue: '22:00',
    description: 'Quiet hours start, HH:mm',
    enforcedBy: null,
  },
  {
    key: 'notifications.quiet_hours_end',
    section: 'notifications',
    valueType: 'string',
    defaultValue: '07:00',
    description: 'Quiet hours end, HH:mm',
    enforcedBy: null,
  },
  {
    key: 'notifications.quiet_hours_timezone',
    section: 'notifications',
    valueType: 'string',
    defaultValue: 'UTC',
    description: 'IANA timezone the quiet hours window is evaluated in',
    enforcedBy: null,
  },

  // ── Features ─────────────────────────────────────────────────────────────
  {
    key: 'features.enabled_modules',
    section: 'features',
    valueType: 'json',
    defaultValue: '[]',
    description: 'Product modules the tenant may open',
    enforcedBy: null,
  },
  {
    key: 'features.advanced_analytics',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Advanced analytics surfaces',
    enforcedBy: null,
  },
  {
    key: 'features.custom_reports',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Tenant-authored report definitions',
    enforcedBy: null,
  },
  {
    key: 'features.data_export',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Export tenant data',
    enforcedBy: null,
  },
  {
    key: 'features.data_import',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Bulk import tenant data',
    enforcedBy: null,
  },
  {
    key: 'features.bulk_operations',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Bulk edit and delete actions',
    enforcedBy: null,
  },
  {
    key: 'features.audit_log',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Tenant-visible audit log',
    enforcedBy: null,
  },
  {
    key: 'features.api_access',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Public API access for the tenant',
    enforcedBy: null,
  },
  {
    key: 'features.mobile_access',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'AquaMobil access for the tenant',
    enforcedBy: null,
  },
  {
    key: 'features.offline_mode',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Offline-first mobile operation',
    enforcedBy: null,
  },
  {
    key: 'features.third_party_integrations',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Catalogue integrations',
    enforcedBy: null,
  },
  {
    key: 'features.custom_integrations',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'false',
    description: 'Tenant-authored integrations',
    enforcedBy: null,
  },
  {
    key: 'features.iot_device_support',
    section: 'features',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Edge and IoT device onboarding',
    enforcedBy: null,
  },
  {
    key: 'features.beta_features',
    section: 'features',
    valueType: 'json',
    defaultValue: '[]',
    description: 'Beta feature identifiers opened for the tenant',
    enforcedBy: null,
  },

  // ── Data retention ───────────────────────────────────────────────────────
  {
    key: 'retention.audit_log_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '90',
    description: 'Days audit log entries are kept',
    enforcedBy: null,
  },
  {
    key: 'retention.activity_log_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '30',
    description: 'Days activity log entries are kept',
    enforcedBy: null,
  },
  {
    key: 'retention.sensor_data_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '365',
    description: 'Days raw sensor readings are kept',
    enforcedBy: null,
  },
  {
    key: 'retention.alert_history_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '180',
    description: 'Days alert history is kept',
    enforcedBy: null,
  },
  {
    key: 'retention.deleted_data_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '30',
    description: 'Days soft-deleted rows are kept before permanent removal',
    enforcedBy: null,
  },
  {
    key: 'retention.backup_days',
    section: 'retention',
    valueType: 'number',
    defaultValue: '30',
    description: 'Days backups are kept',
    enforcedBy: null,
  },
  {
    key: 'retention.auto_delete_enabled',
    section: 'retention',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Delete data automatically once its retention window closes',
    enforcedBy: null,
  },
  {
    key: 'retention.archive_before_delete',
    section: 'retention',
    valueType: 'boolean',
    defaultValue: 'true',
    description: 'Archive data before automatic deletion',
    enforcedBy: null,
  },
] as const satisfies readonly TenantSettingDefinition[];

/** One vocabulary entry, narrowed to its own literal key and value type. */
export type TenantSetting = (typeof TENANT_SETTINGS)[number];

/** Every key the vocabulary defines. A key outside this union does not exist. */
export type TenantSettingKey = TenantSetting['key'];

/** Keys whose stored value is a string. */
export type TenantSettingStringKey = Extract<
  TenantSetting,
  { valueType: 'string' }
>['key'];

/** Keys whose stored value is a number. */
export type TenantSettingNumberKey = Extract<
  TenantSetting,
  { valueType: 'number' }
>['key'];

/** Keys whose stored value is a boolean. */
export type TenantSettingBooleanKey = Extract<
  TenantSetting,
  { valueType: 'boolean' }
>['key'];

/** Keys whose stored value is a JSON string list. */
export type TenantSettingListKey = Extract<
  TenantSetting,
  { valueType: 'json' }
>['key'];
